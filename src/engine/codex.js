'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('@actions/core');
const { TransientError, classifyTransient } = require('../failover');
const { priceFromTable, spawnFromRequest, sumCost, emptyTokens, addTokens } = require('../usage');
const { makeCliAdapter } = require('./cli');
const { createJsonRpcClient } = require('./jsonrpc');
const { resolveReasoningTier } = require('../effort');
const { version: ACTION_VERSION } = require('../../package.json');

// [LAW:no-ambient-temporal-coupling] Pin off '@latest' — the same trap claude-code hit: an unowned,
// time-varying input that lets an upstream npm release break a run with nothing here changing. Pinned
// to the release the app-server conversation below was verified against (2026-09-06); CODEX_VERSION
// overrides it without cutting a release. [LAW:one-source-of-truth]
const CODEX_VERSION = process.env.CODEX_VERSION || '0.142.3';
const CODEX_PACKAGE = `@openai/codex@${CODEX_VERSION}`;
const CODEX_TIMEOUT_MS = 3_000_000;

// What this client calls itself in the app-server handshake; codex echoes it into its user agent.
const CLIENT_INFO = { name: 'copirate-code-review-agent', version: ACTION_VERSION };

// [LAW:one-source-of-truth] The collector's name in codex's MCP registry, declared once: it heads the
// config.toml section below and is the server whose tool-call approvals the session grants.
const COLLECTOR_SERVER_NAME = 'review_collector';

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
// approval_policy = "never" covers shell commands only; MCP tool calls have their own approval
// gate, which the app-server surfaces as an elicitation request the session answers (see
// appServerSession) — so the sandbox stays read-only instead of being bypassed wholesale.
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
    `[mcp_servers.${COLLECTOR_SERVER_NAME}]`,
    `command = ${q(command)}`,
    `args = ${arr(args)}`,
    '',
    `[mcp_servers.${COLLECTOR_SERVER_NAME}.env]`,
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
// The engine is codex's app-server over stdio: a JSON-RPC conversation (appServerSession) rather
// than `exec --json`, because only the app-server reports usage PER MODEL REQUEST — the fact a
// context-tiered price needs (see extractUsage). The thread it opens inherits the process cwd (the
// isolated scratch dir cli.js owns; verified live, and it need not be a git repo) and config.toml's
// read-only sandbox and never-approve policy — no bypass flag, so the sandbox stays in force.
//
// Env is an explicit allowlist — never process.env spread. Codex is an AI agent that can
// read env vars via shell expressions; spreading process.env would expose GITHUB_TOKEN and
// all repo secrets to prompt-injection payloads in the diff under review. Only the minimum
// required variables are passed: PATH (npx resolution), HOME (system tools), and CODEX_HOME
// (config + credential isolation). [LAW:effects-at-boundaries]
function buildCommand({ home }) {
  return {
    command: 'npx',
    args: ['-y', CODEX_PACKAGE, 'app-server'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: home,
    },
  };
}

// [LAW:effects-at-boundaries] The one conversation this engine holds, over the io runEngine owns:
//
//   initialize -> initialized -> thread/start -> turn/start -> ...notifications... -> turn/completed -> EOF
//
// Verified live against codex-cli 0.142.3 (2026-09-06). Every model request the turn makes emits one
// thread/tokenUsage/updated whose `last` is THAT request's usage — six requests of ~16-17K context
// each summed exactly to `total` — which is the per-request context `exec --json` collapsed into one
// turn total. The collector's tool calls arrive as mcpServer/elicitation/request approvals even under
// approval_policy "never" (the gate `exec` needed --dangerously-bypass-approvals-and-sandbox for);
// they are granted here for the collector alone, so the read-only sandbox stays in force. The server
// exits on stdin EOF, which is how the session ends it.
//
// [LAW:no-silent-failure] Any other server request is REFUSED with a JSON-RPC error and announced —
// a command approval under a never-approve policy, a file-change approval in a read-only sandbox —
// never granted by default, and never left unanswered, which would stall the turn until the timeout.
// The session resolves with THE SESSION RECORD, { turn, requests }: the completed turn as codex
// reported it (status + error) and one usage breakdown per model request, in order. A stream that
// closes before the turn completes rejects, so an engine that dies mid-review is the loud cause.
async function appServerSession(io, prompt) {
  const requests = [];
  let settleTurn;
  const completed = new Promise(resolve => { settleTurn = resolve; });
  const rpc = createJsonRpcClient(io, msg => {
    if (msg.id !== undefined) {
      const approval = msg.params?._meta?.codex_approval_kind === 'mcp_tool_call' && msg.params.serverName === COLLECTOR_SERVER_NAME;
      if (msg.method === 'mcpServer/elicitation/request' && approval) {
        rpc.respond(msg.id, { action: 'accept' });
      } else {
        core.warning(`codex asked for ${msg.method}, which the review engine does not grant; refused.`);
        rpc.refuse(msg.id, `${msg.method} is not granted to a review engine`);
      }
      return;
    }
    if (msg.method === 'thread/tokenUsage/updated') requests.push(msg.params.tokenUsage.last);
    if (msg.method === 'turn/completed') settleTurn(msg.params.turn);
  });
  await rpc.request('initialize', { clientInfo: CLIENT_INFO });
  rpc.notify('initialized');
  const { thread } = await rpc.request('thread/start', {});
  await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: prompt }] });
  const turn = await Promise.race([
    completed,
    io.closed.then(() => { throw new Error('Codex review did not complete: the app-server exited before turn/completed.'); }),
  ]);
  io.end();
  return { turn, requests };
}

// [LAW:no-silent-failure] The turn's own status is the verdict: 'completed' is the one success, and
// 'failed' / 'interrupted' surface codex's error, with its typed class (codexErrorInfo) in the text
// so classifyError can read a quota wall or an overloaded server off it.
function assertSucceeded({ turn }) {
  if (turn.status === 'completed') return;
  const detail = turn.error
    ? `${turn.error.message}${turn.error.codexErrorInfo ? ` (${JSON.stringify(turn.error.codexErrorInfo)})` : ''}`
    : 'no error reported';
  throw new Error(`Codex review ${turn.status}: ${detail}`);
}

// [LAW:parse-dont-validate] OpenAI reports an input total that INCLUDES its cached subset, so this is
// the one place that overlap is resolved into THE TOKEN RECORD's disjoint classes (src/usage.js). The
// clamp belongs here, at the vendor boundary, and nowhere downstream: a foreign payload reporting more
// cached than total tokens is the only way that state can arise, so absorbing it where the foreign
// shape is read is what lets every consumer take the classes at face value. reasoningOutputTokens is
// a subset of outputTokens (verified: totalTokens = inputTokens + outputTokens) and bills as output.
function tokensOfRequest(u) {
  const inputCacheHit = Math.min(u.cachedInputTokens, u.inputTokens);
  return { inputCacheMiss: u.inputTokens - inputCacheHit, inputCacheHit, output: u.outputTokens };
}

// [LAW:effects-at-boundaries] Pure: reads usage from the session record and returns a Usage value, or
// null when the turn made no model request that reported usage. Codex emits NO USD — 'actual USD' is
// tokens x the centralized price table (priceFromTable), which reports its own reason when it cannot
// price a spawn and never a fabricated zero. [LAW:no-silent-failure]
//
// Each request is priced ON ITS OWN, at the card its own context length selects, and the spawn's
// cost is the sum (sumCost — one unpriced request makes the whole spawn unpriced, carrying its
// reason). That is what makes a context-tiered model (gpt-5.6-*, ≤272K / >272K per request) price
// exactly: a review turn totals well over 272K across its requests while no single request need be,
// and pricing the total at either card would be the confident misprice zai-cost-truth-p5o exists to
// end. spawnFromRequest is the narrow claim each request supports — its context is exactly its own
// input count. The usage record keeps the per-request breakdown beside the summed tokens, so the
// figure can be re-derived request by request later. [FRAMING:representation]
//
// `startedAt` is the spawn's start instant, supplied by makeCliAdapter — the price table is a
// schedule, so the rate is selected by WHEN this spawn ran, not by a clock read in here.
// [LAW:types-are-the-program] cost is a discriminated value, and priceFromTable returns it whole —
// dollars, or unpriced carrying the reason it discovered. This adapter never manufactures that
// reason: codex can reach two of them (the model is absent from the table, or its schedule covers
// no card for a request) and telling them apart is the price table's job, not the adapter's.
// The basis is never 'subscription': codex declares credentialKinds ['api-key'], so no codex run can
// ever be billed to a subscription and this adapter has no notional arm to reach.
function extractUsage({ requests }, config, startedAt) {
  if (requests.length === 0) return null;
  const perRequest = requests.map(tokensOfRequest);
  const costs = perRequest.map(tokens => priceFromTable(spawnFromRequest(startedAt, tokens), config.model));
  return { tokens: perRequest.reduce(addTokens, emptyTokens()), cost: sumCost(costs), requests: perRequest };
}

// [LAW:single-enforcer] The shared transient vocabulary (429/529/network drop) is classified once in
// src/failover.js (classifyTransient); codex consumes it and adds only its genuinely OpenAI-specific
// class — a billing limit (insufficient_quota on the wire, usageLimitExceeded as the app-server's typed
// class) that also clears with time or a new quota window. codex doesn't surface Retry-After in a
// parseable form, so it omits the extractor and rate-limits fall to exponential backoff.
// [LAW:one-source-of-truth] No local copy of the 429/529/network patterns to drift.
function classifyError(err, text) {
  return classifyTransient(err, text)
    ?? (/insufficient.quota|quota.exceeded|usageLimitExceeded/i.test(text) ? new TransientError(`quota exceeded: ${err.message}`) : err);
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
  session: appServerSession,
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
  appServerSession,
  assertSucceeded,
  classifyError,
  extractUsage,
};
