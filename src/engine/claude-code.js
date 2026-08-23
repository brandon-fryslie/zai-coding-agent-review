'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseRetryAfterMs, classifyTransient } = require('../failover');
const { parseJsonEnvelope, formatOutputTail } = require('./run');
const { makeCliAdapter } = require('./cli');
const { isAnthropicEndpoint, computeCostUsd } = require('../usage');
const { resolveReasoningTier } = require('../effort');

const CLAUDE_CODE_PACKAGE = '@anthropic-ai/claude-code';
// [LAW:no-ambient-temporal-coupling] Pin the CLI version — never '@latest'. '@latest' makes every
// run depend on whatever npm serves at execution time: an unowned, time-varying input no one in this
// repo controls. claude-code 2.1.185 busy-spins on startup (99% CPU, even `--version`) in some runner
// images — e.g. Gitea's slim runner-images:ubuntu-latest — hanging every review to the job timeout
// with nothing here having changed. The pinned default is a known-good release verified end-to-end;
// CLAUDE_CODE_VERSION lets an operator move to a newer fix without cutting a release.
// [LAW:one-source-of-truth] One owned version value, defined once here.
const CLAUDE_CODE_VERSION = process.env.CLAUDE_CODE_VERSION || '2.1.0';
const CLAUDE_TIMEOUT_MS = 3_000_000;

// [LAW:one-source-of-truth] The engine's reasoning-effort range, declared once (low→high) and
// referenced by BOTH the capability declaration (config validation) and buildCommand (resolving an
// abstract tier to what this engine supports). The ordering low→high is what resolveReasoningTier's
// nearest-rung clamp relies on.
const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];

// [LAW:one-source-of-truth] Declared first so CLAUDE_ALLOWED_TOOLS can derive its MCP
// entries from here. toolNames feeds the prompt; CLAUDE_ALLOWED_TOOLS feeds --allowedTools.
// Both must agree — a tool the model is told to call must also be on the allowed list.
const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};

// [LAW:single-enforcer] Every collector tool the model is told to call is also allowed here — the
// allowlist derives from TOOL_NAMES, so a new tool (add_scope) is reachable by construction.
const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  ...Object.values(TOOL_NAMES),
];
const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'WebFetch',
  'WebSearch',
];

// [LAW:effects-at-boundaries] The only effect in this adapter: writing files to a temp HOME.
// The caller passes the full interface context { config, instructionsPath, collector };
// this adapter only needs instructionsPath. Codex/opencode adapters will consume config
// (model/endpoint) and collector (MCP server registration in config.toml/opencode.json).
function materializeHome({ instructionsPath }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-home-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // [LAW:single-enforcer] The packaged action owns reusable reviewer instructions.
  fs.copyFileSync(instructionsPath, path.join(claudeDir, 'CLAUDE.md'));
  return home;
}

// [LAW:dataflow-not-control-flow] The credential's DELIVERY CHANNEL is a value, not a branch: each
// credential kind maps to the env fragment that carries it, and buildCommand splices whichever
// fragment it is handed without ever asking which one. A new kind is one entry here, no new structure.
// Keyed by the credential's KIND rather than by endpoint or provider, because that is the only thing
// that decides the channel — an API key and an OAuth token speak the same wire protocol to the same
// Messages API and differ solely in which env var the CLI reads them from.
//
// [LAW:types-are-the-program] The fragments are DISJOINT, and that is load-bearing rather than tidy.
// The CLI's auth precedence is cloud-provider creds > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY >
// apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN, and the first two win SILENTLY in non-interactive mode — so
// a run that set both would quietly bill the API key while the operator believed the subscription paid
// for it, with no error anywhere to notice. Making each kind produce only its own vars means that
// state cannot be constructed. The explicit env allowlist below is the other half: no ambient
// ANTHROPIC_API_KEY on the runner can reach the child and outrank the OAuth token either.
const AUTH_ENV = {
  'api-key': ({ baseUrl, credential }) => ({
    ANTHROPIC_AUTH_TOKEN: credential.value,
    ANTHROPIC_BASE_URL: baseUrl,
  }),
  // No ANTHROPIC_BASE_URL: an OAuth credential is only reachable through a preset whose baseUrl is
  // PINNED in code (src/provider.js), and that host is already the CLI's own default. Setting it would
  // add a second, mutable path to a value the security model deliberately fixes.
  oauth: ({ credential }) => ({ CLAUDE_CODE_OAUTH_TOKEN: credential.value }),
};

// [LAW:no-silent-failure] An unmapped method must never spawn an engine carrying NO credential — that
// surfaces as an opaque 401 deep inside the CLI, minutes and one full prompt later. Config validation
// rejects unknown methods upstream against the adapter's capability declaration; this names the gap
// loudly if the enumeration and this map ever drift apart.
function authEnv(endpoint) {
  const fragment = AUTH_ENV[endpoint.credential.kind];
  if (!fragment) {
    throw new Error(
      `claude-code: no auth env mapping for credential kind '${endpoint.credential.kind}'. ` +
      `Known kinds: ${Object.keys(AUTH_ENV).join(', ')}.`,
    );
  }
  return fragment(endpoint);
}

// [LAW:effects-at-boundaries] Pure: returns a full spawn spec from a validated ReviewConfig.
// [LAW:single-enforcer] Auth translation happens exactly once, here in the adapter: the resolved
// config's auth variant becomes the engine's own credential channel via AUTH_ENV and nowhere else.
function buildCommand({ config, collector, home }) {
  // [LAW:one-type-per-behavior] One canonical output format: `stream-json --verbose` emits every
  // assistant/thinking/tool-use event as JSONL, so every session transcript carries the full
  // prompt/response/thinking/tool-call flow (the signal for "did the engine actually read the repo").
  // parseResultEnvelope normalizes the terminal `result` event back to the same envelope the plain
  // `json` form produced, so assertSucceeded/extractUsage are unaffected. stream-json requires --verbose.
  //
  // NEVER add `--bare` here, however tempting its startup saving looks: `--bare` does not read
  // CLAUDE_CODE_OAUTH_TOKEN at all, so it silently breaks every subscription-auth run while leaving
  // api-key runs working — the worst shape of breakage, invisible on the path most tests exercise.
  const args = [
    '-y',
    `${CLAUDE_CODE_PACKAGE}@${CLAUDE_CODE_VERSION}`,
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--no-session-persistence',
    '--tools',
    'Read,Grep,Glob',
    '--allowedTools',
    CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    CLAUDE_DISALLOWED_TOOLS.join(','),
    '--mcp-config',
    collector.mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
  ];

  if (config.model) {
    args.push('--model', config.model);
  }

  if (config.systemPrompt) {
    args.push('--append-system-prompt', config.systemPrompt);
  }

  args.push('Review the pull request instructions and diff from stdin.');

  // [LAW:single-enforcer] Env is an explicit allowlist — never a process.env spread, matching the
  // codex/opencode adapters so all three enforce the same isolation posture (the boundary CLAUDE.md
  // documents). claude-code is an AI agent that could surface an env var via a tool result or MCP
  // call; spreading process.env would sit GITHUB_TOKEN and every runner secret in the child's
  // environment for a prompt-injection payload in the diff under review to exfiltrate. Only the
  // minimum is passed: the runner vars npx/node need (PATH resolution, TMPDIR for scratch, and the
  // npm download cache so npx does not re-fetch the pinned CLI into the throwaway HOME every run —
  // each omitted by node's spawn when unset, so an absent one is simply not present in the child)
  // plus the claude-code-specific values this adapter owns (temp HOME, the auth translation, timeout,
  // and CLI flags). [LAW:effects-at-boundaries]
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    npm_config_cache: process.env.npm_config_cache,
    HOME: home,
    ...authEnv(config.endpoint),
    ANTHROPIC_MODEL: config.model,
    API_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    NO_COLOR: '1',
  };

  // [LAW:single-enforcer] Resolve the reasoning tier to what THIS engine supports through the one
  // resolver — an abstract tier the engine offers passes through unchanged (the case today, since
  // config.reasoning is already validated in-range), one it names differently clamps to the nearest
  // rung, and null (unset, or opencode's empty range) leaves the engine's own default.
  const effortLevel = resolveReasoningTier(config.reasoning ?? null, CLAUDE_REASONING_EFFORTS);
  if (effortLevel) {
    env.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
  }

  return { command: 'npx', args, env };
}

// [LAW:single-enforcer] One envelope-extraction function, robust to BOTH output formats claude-code
// can emit: the single JSON object of `--output-format json` (default path) and the JSONL event
// stream of `--output-format stream-json` (debug path). In stream-json the terminal `type:"result"`
// line carries the SAME fields as the single-object envelope, so callers stay uniform — the format
// difference is absorbed here as a value, never branched on downstream. [LAW:dataflow-not-control-flow]
// The default path is unchanged: a single JSON object parses whole and is returned verbatim.
function parseResultEnvelope(stdout) {
  const whole = parseJsonEnvelope(stdout);
  if (whole && whole.type === 'result') return whole;
  // stream-json: the result envelope is the LAST terminal `result` event in the JSONL stream. The
  // 8 MiB trailing-window retention (engine/run.js) preserves it because it is emitted last.
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = parseJsonEnvelope(line);
    if (obj && obj.type === 'result') return obj;
  }
  // Single-object envelope without an explicit type (or truncated output): fall back to whatever the
  // whole-stdout parse recovered, so behavior on the default path is identical to before.
  return whole;
}

function assertSucceeded(stdout) {
  const parsed = parseResultEnvelope(stdout);
  if (!parsed) {
    throw new Error(`Claude Code returned invalid JSON.\n\n${formatOutputTail('stdout tail', stdout)}`);
  }
  if (parsed.is_error || parsed.subtype === 'error') {
    throw new Error(`Claude Code review failed: ${parsed.result || 'unknown error'}`);
  }
}

// [LAW:effects-at-boundaries] Pure: reads usage from the JSON envelope and returns a Usage value,
// or null when usage is absent. The input count sums all input-side fields (fresh + cache read +
// cache write) so it reflects the total prompt tokens the run processed.
// total_cost_usd is Claude Code's own CLIENT-SIDE estimate (tokens × its bundled ANTHROPIC price
// table), not a billed charge — so the renderer marks every available cost line "est.".
function extractUsage(stdout, config) {
  const env = parseResultEnvelope(stdout);
  if (!env || !env.usage) return null;
  const u = env.usage;
  const freshInput = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const inputTokens = freshInput + cacheRead + cacheWrite;
  const outputTokens = u.output_tokens ?? 0;
  // [LAW:types-are-the-program] Anthropic-style buckets → the price-table shape: cache reads bill at
  // the discounted cached rate, fresh + cache writes at the full input rate. cachedInputTokens is the
  // cached subset of inputTokens, exactly what computeCostUsd expects.
  const cost = costFromEnvelope(env, config, { inputTokens, cachedInputTokens: cacheRead, outputTokens });
  return { inputTokens, outputTokens, cost };
}

// [LAW:types-are-the-program] cost is a discriminated value, resolved by the one fact that decides
// the cost basis: is the endpoint genuinely Anthropic? If so, total_cost_usd is Claude Code's own
// Anthropic-priced estimate (or 'not-reported' when absent). If not (z.ai, deepseek, …), that figure
// is the wrong vendor's, so it is ignored entirely and the cost is computed from the provider's own
// entry in the price table — 'no-price' when the model is not yet listed. [LAW:no-silent-failure]
function costFromEnvelope(env, config, buckets) {
  if (isAnthropicEndpoint(config)) {
    // [LAW:types-are-the-program] available:true must carry a FINITE usd — Number.isFinite, not
    // typeof==='number' (which accepts NaN), so a garbage total_cost_usd is 'not-reported', never a
    // NaN that later renders "$NaN" or poisons a PR cost total. The invariant is enforced here at the
    // source so no downstream consumer needs its own guard.
    return Number.isFinite(env.total_cost_usd)
      ? { available: true, usd: env.total_cost_usd }
      : { available: false, reason: 'not-reported' };
  }
  const usd = computeCostUsd(buckets, config.model);
  return usd == null ? { available: false, reason: 'no-price' } : { available: true, usd };
}

// [LAW:single-enforcer] Classification of the shared transient vocabulary (429/529/network drop) lives
// once in src/failover.js (classifyTransient); this adapter contributes only its genuinely
// engine-specific bit — the Anthropic-compatible CLI echoes the Retry-After header, so it passes
// parseRetryAfterMs as the rate-limit hint extractor. Nothing else is claude-code-specific: no local
// pattern set to drift from the other engines'. [LAW:one-source-of-truth]
function classifyError(err, text) {
  return classifyTransient(err, text, parseRetryAfterMs) ?? err;
}

// [LAW:one-source-of-truth] classifyClaudeError is the stable public name re-exported
// from src/index.js for test compatibility; classifyError is the adapter interface name.
const classifyClaudeError = classifyError;

// [LAW:one-type-per-behavior] The CLI lifecycle is identical across engines, so the adapter is built
// from the shared makeCliAdapter factory; this module supplies only the spawn primitives (the spec).
// The factory exposes the lifted produceReview seam; the spec's primitives stay CLI-internal.
const claudeCodeAdapter = makeCliAdapter({
  name: 'claude-code',
  timeoutMs: CLAUDE_TIMEOUT_MS,
  capabilities: {
    // [LAW:types-are-the-program] Capability declarations are the single source of truth
    // for config validation in src/config.js (T4). Illegal combos are rejected at load
    // time via these declarations, never discovered at spawn time.
    reasoningEfforts: CLAUDE_REASONING_EFFORTS,
    apiTypes: ['anthropic-messages'],
    // [LAW:one-source-of-truth] Derived from AUTH_ENV rather than restated: the credential kinds this
    // engine ADVERTISES are exactly the ones it can actually translate into a channel, so declaring
    // one it cannot spawn is not a mistake that can be made.
    credentialKinds: Object.keys(AUTH_ENV),
  },
  // [LAW:one-source-of-truth] Reference TOOL_NAMES — do not redeclare the strings here.
  toolNames: TOOL_NAMES,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
});

// The spawn primitives are exported as pure functions for direct unit testing of their behavior
// (byte-identical args/env, error classification, usage parsing) — they are NOT part of the public
// adapter interface. [LAW:behavior-not-structure]
module.exports = {
  CLAUDE_TIMEOUT_MS,
  classifyClaudeError,
  claudeCodeAdapter,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
  parseResultEnvelope,
};
