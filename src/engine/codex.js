'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TransientError, classifyTransient } = require('../failover');
const { computeCostUsd } = require('../usage');
const { makeCliAdapter } = require('./cli');
const { resolveReasoningTier } = require('../effort');

// [LAW:no-ambient-temporal-coupling] Pin off '@latest' — the same trap claude-code hit: an unowned,
// time-varying input that lets an upstream npm release break a run with nothing here changing. Pinned
// to a known-good release; CODEX_VERSION overrides it without cutting a release. [LAW:one-source-of-truth]
const CODEX_VERSION = process.env.CODEX_VERSION || '0.141.0';
const CODEX_PACKAGE = `@openai/codex@${CODEX_VERSION}`;
const CODEX_TIMEOUT_MS = 3_000_000;

// [LAW:one-source-of-truth] The engine's reasoning-effort range, declared once (low→high) and
// referenced by BOTH the capability declaration (config validation) and buildConfigToml (resolving an
// abstract tier to what this engine supports). The ordering low→high is what resolveReasoningTier's
// nearest-rung clamp relies on.
const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// Internal provider name used in config.toml. Codex requires an explicit 'name' field
// inside each [model_providers.<key>] section — without it, config load fails with
// "provider name must not be empty". Must be alphanumeric, no underscores or hyphens.
// 'api' is generic and avoids collisions with codex built-in names (e.g. 'openai').
const INTERNAL_PROVIDER = 'api';

// [LAW:one-source-of-truth] Declared once; both the prompt (via toolNames) and the
// config.toml (N/A for codex) reference the same strings. Codex surfaces MCP tools with
// the same naming convention as Claude Code (verified via live handshake, 2026-06-12).
const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};

// [LAW:effects-at-boundaries] Pure: produces TOML text from values, touches no filesystem.
// Codex 0.139 requires: explicit `name` field in each model_provider entry; the bare model
// name in `model` with the provider selected by `model_provider` (the old "<provider>/<model>"
// form is sent verbatim to the API and 400s as model_not_found); REVIEW_COLLECTOR_RECORDS in
// the mcp_servers env sub-table. The credential is NOT carried by a provider env_key — Codex
// authenticates the Responses transport from auth.json (written in materializeHome).
// --dangerously-bypass-approvals-and-sandbox is required in the spawn invocation because
// approval_policy = "never" only covers shell commands; MCP tool calls have a separate
// approval gate that requires this flag in non-interactive (--json) mode.
function buildConfigToml(config, collectorSpawn) {
  const { command, args, env: collectorEnv } = collectorSpawn;

  // TOML basic-string escaping per TOML 1.0 spec: backslash first, then double-quote, then
  // control characters. Raw \n/\r in a single-line basic string breaks TOML parsing and
  // could allow injection (e.g., a crafted baseUrl containing \napproval_policy = "always"
  // overrides a hardened setting). [LAW:effects-at-boundaries] values from external sources
  // (baseUrl, the credential value, recordsPath) must be sanitized at this trust boundary.
  const q = v => `"${String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
  const arr = vs => `[${vs.map(q).join(', ')}]`;

  const lines = [
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `model = ${q(config.model)}`,
    `model_provider = ${q(INTERNAL_PROVIDER)}`,
  ];
  // [LAW:single-enforcer] Resolve the reasoning tier through the one resolver — a tier this engine
  // offers passes through unchanged (the case today, config.reasoning being validated in-range), one
  // it names differently clamps to the nearest rung, and null leaves the engine's own default.
  const reasoningEffort = resolveReasoningTier(config.reasoning ?? null, CODEX_REASONING_EFFORTS);
  if (reasoningEffort) {
    lines.push(`model_reasoning_effort = ${q(reasoningEffort)}`);
  }

  lines.push(
    '',
    `[model_providers.${INTERNAL_PROVIDER}]`,
    `name = ${q(INTERNAL_PROVIDER)}`,
    `base_url = ${q(config.endpoint.baseUrl)}`,
    // Explicitly opt the custom provider into OpenAI API-key auth so Codex uses the
    // auth.json credential, rather than relying on implicit fallback. [LAW:types-are-the-program]
    `requires_openai_auth = true`,
    '',
    '[mcp_servers.review_collector]',
    `command = ${q(command)}`,
    `args = ${arr(args)}`,
    '',
    '[mcp_servers.review_collector.env]',
    `REVIEW_COLLECTOR_RECORDS = ${q(collectorEnv.REVIEW_COLLECTOR_RECORDS)}`,
  );

  return lines.join('\n') + '\n';
}

// [LAW:effects-at-boundaries] The only effect in this adapter: writing files to a temp home.
// Returns the temp dir path, which becomes CODEX_HOME for the spawned process.
function materializeHome({ config, instructionsPath, collector }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-codex-home-'));

  // [LAW:single-enforcer] Instructions are copied from the one shared source.
  fs.copyFileSync(instructionsPath, path.join(home, 'AGENTS.md'));

  // [LAW:single-enforcer] auth.json is the one credential channel Codex 0.139 reads for the
  // Responses transport; a provider env_key is ignored there and yields 401 missing-bearer.
  // The key name is Codex's fixed API-key slot, independent of the config's credentialEnv.
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: config.endpoint.credential.value }),
    'utf8',
  );

  // Read the collector's already-computed spawn spec rather than recomputing it.
  // [LAW:one-source-of-truth] createReviewCollector owns these paths and the node binary ref.
  const mcpCfg = JSON.parse(fs.readFileSync(collector.mcpConfigPath, 'utf8'));
  const collectorSpawn = mcpCfg.mcpServers.review_collector;

  fs.writeFileSync(path.join(home, 'config.toml'), buildConfigToml(config, collectorSpawn), 'utf8');
  return home;
}

// [LAW:effects-at-boundaries] Pure: returns a full spawn spec from the validated ReviewConfig.
// The credential is not passed via env — it lives in CODEX_HOME/auth.json (materializeHome),
// the one channel Codex reads for the Responses transport. [LAW:single-enforcer]
// --dangerously-bypass-approvals-and-sandbox is intentional for CI: GitHub Actions is an
// externally sandboxed environment (per Codex docs: "Intended solely for running in
// environments that are externally sandboxed"). MCP tool calls do not auto-execute in
// --json mode without this flag regardless of approval_policy in config.toml.
//
// Env is an explicit allowlist — never process.env spread. Codex is an AI agent that can
// read env vars via shell expressions; spreading process.env would expose GITHUB_TOKEN and
// all repo secrets to prompt-injection payloads in the diff under review. Only the minimum
// required variables are passed: PATH (npx resolution), HOME (system tools), and CODEX_HOME
// (config + credential isolation). [LAW:effects-at-boundaries]
function buildCommand({ home }) {
  return {
    command: 'npx',
    // --skip-git-repo-check: the engine's cwd is an isolated scratch dir (an instruction-injection
    // guard owned in cli.js), which is NOT a git repo. Without this flag `codex exec` refuses to run
    // outside a git repo and hangs waiting on stdin. The repo itself is read by absolute path; the
    // sandbox bypass already permits reads anywhere. [LAW:no-silent-failure]
    args: ['-y', CODEX_PACKAGE, 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: home,
    },
  };
}

// Parse the JSONL event stream from codex exec --json. Non-JSON lines (stderr noise) are skipped.
// [LAW:no-silent-failure] Both failure modes are surfaced:
//   turn.failed  — explicit engine error (throw immediately)
//   no turn.completed — Codex exited 0 but the turn never finished (interrupted mid-turn,
//     internal timeout, buffering error). Without this check a clean-exit incomplete turn
//     silently passes as success with no findings collected.
function assertSucceeded(stdout) {
  let completed = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'turn.failed') {
      throw new Error(`Codex review failed: ${event.error?.message ?? 'unknown error'}`);
    }
    if (event.type === 'turn.completed') completed = true;
  }
  if (!completed) {
    throw new Error('Codex review did not complete: turn.completed event was not emitted.');
  }
}

// [LAW:effects-at-boundaries] Pure: reads usage from the engine's own JSONL output and returns
// a Usage value, or null when no usage was reported. Codex emits NO USD — 'actual USD' is
// tokens x the centralized price table (computeCostUsd); a model absent from the
// table yields cost {basis:'unpriced', reason:'no-price'}, never a fabricated zero. [LAW:no-silent-failure]
// The cumulative turn usage rides on the final turn.completed event; later events overwrite
// earlier ones so the last wins. An absent/empty usage object (no token fields) is reported as
// no usage (null), not as a $0.00 run. [LAW:dataflow-not-control-flow]
function extractUsage(stdout, config) {
  let usage = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
  }
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cachedInputTokens = usage.cached_input_tokens ?? 0;
  const costUsd = computeCostUsd({ inputTokens, outputTokens, cachedInputTokens }, config.model);
  // [LAW:types-are-the-program] cost is a discriminated value. Codex reports no USD, so a null
  // here means exactly one thing — the model is absent from the price table — and the adapter
  // declares that reason at the point it knows it, rather than the boundary re-deriving it.
  // The basis is always 'dollars': codex declares credentialKinds ['api-key'], so no codex run can
  // ever be billed to a subscription and this adapter has no notional arm to reach.
  const cost = costUsd == null ? { basis: 'unpriced', reason: 'no-price' } : { basis: 'dollars', usd: costUsd };
  return { inputTokens, outputTokens, cost };
}

// [LAW:single-enforcer] The shared transient vocabulary (429/529/network drop) is classified once in
// src/failover.js (classifyTransient); codex consumes it and adds only its genuinely OpenAI-specific
// class — insufficient_quota, a billing limit that also clears with time or a new quota window. codex
// doesn't surface Retry-After in a parseable form, so it omits the extractor and rate-limits fall to
// exponential backoff. [LAW:one-source-of-truth] No local copy of the 429/529/network patterns to drift.
function classifyError(err, text) {
  return classifyTransient(err, text)
    ?? (/insufficient.quota|quota.exceeded/i.test(text) ? new TransientError(`quota exceeded: ${err.message}`) : err);
}

// [LAW:one-type-per-behavior] The CLI lifecycle is identical across engines, so the adapter is built
// from the shared makeCliAdapter factory; this module supplies only the spawn primitives (the spec).
const codexAdapter = makeCliAdapter({
  name: 'codex',
  timeoutMs: CODEX_TIMEOUT_MS,
  capabilities: {
    // [LAW:types-are-the-program] Capability declarations are the single source of truth
    // for config validation in src/config.js. Illegal combos (e.g. anthropic-messages
    // endpoint with codex) are rejected at load time, never discovered at spawn time.
    reasoningEfforts: CODEX_REASONING_EFFORTS,
    apiTypes: ['openai-responses'],
    // Codex authenticates only by API key (auth.json). An OAuth/subscription credential is meaningless
    // here, so config validation rejects it at load time rather than writing an unusable auth.json.
    credentialKinds: ['api-key'],
  },
  toolNames: TOOL_NAMES,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
});

// The spawn primitives are exported as pure functions for direct unit testing of their behavior —
// they are NOT part of the public adapter interface. [LAW:behavior-not-structure]
module.exports = {
  codexAdapter,
  CODEX_TIMEOUT_MS,
  buildConfigToml,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
};
