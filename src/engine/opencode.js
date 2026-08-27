'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyTransient } = require('../failover');
const { emptyTokens, addTokens } = require('../usage');
const { makeCliAdapter } = require('./cli');

// [LAW:no-ambient-temporal-coupling] Pin off '@latest' — the same trap claude-code hit: an unowned,
// time-varying input that lets an upstream npm release break a run with nothing here changing. Pinned
// to a known-good release; OPENCODE_VERSION overrides it without cutting a release. [LAW:one-source-of-truth]
const OPENCODE_VERSION = process.env.OPENCODE_VERSION || '1.17.9';
const OPENCODE_PACKAGE = `opencode-ai@${OPENCODE_VERSION}`;
const OPENCODE_TIMEOUT_MS = 3_000_000;

// [LAW:one-source-of-truth] The MCP server key as registered in opencode.json. OpenCode derives
// the tool identifier it surfaces to the model as `<serverKey>_<toolName>` — so this key and the
// collector's own tool names (request_change / finish_review) together determine TOOL_NAMES below.
// Both the opencode.json `mcp` block and the prompt (via toolNames) reference this one constant.
const MCP_SERVER_NAME = 'review_collector';

// [LAW:one-source-of-truth] The exact MCP tool identifiers OpenCode exposes to the model, pinned
// via a live handshake (2026-06-14): OpenCode joins server key + tool name with a single
// underscore and adds NO `mcp__` prefix, so codex/claude-code's `mcp__review_collector__*` names
// are WRONG here. The running model self-reported these exact strings. [LAW:types-are-the-program]
const TOOL_NAMES = {
  requestChange: `${MCP_SERVER_NAME}_request_change`,
  finishReview: `${MCP_SERVER_NAME}_finish_review`,
  addScope: `${MCP_SERVER_NAME}_add_scope`,
  assessDependency: `${MCP_SERVER_NAME}_assess_dependency`,
};

// [LAW:effects-at-boundaries] Pure: builds the opencode.json object from values, touches no
// filesystem. JSON is the serialization (JSON.stringify owns all escaping) so — unlike codex's
// TOML — there is no injection surface to hand-escape.
//
// Provider selection: OpenCode resolves the provider from the model's `<provider>/<model>` prefix
// and we override that provider's endpoint (baseURL + apiKey) here. The credential is written into
// the config rather than referenced as `{env:VAR}` so the spawned process needs no secret in its
// env — mirroring how the codex adapter writes the key into auth.json instead of leaking it as an
// env var the AI subprocess could read. [LAW:single-enforcer]
//
// Read-only is enforced by the permission block: every mutating capability is denied and only the
// read-side tools are allowed. An empty reasoningEfforts capability (declared on the adapter) means
// `reasoning:` is rejected at config load, so nothing reasoning-related reaches this builder.
function buildOpencodeConfig(config, collectorSpawn, agentsPath) {
  const providerId = config.model.split('/')[0];
  // Everything after the provider prefix, slashes included — HF-style ids like
  // `mlx-community/Qwen3-…` are one model name, not nesting.
  const modelId = config.model.split('/').slice(1).join('/');
  return {
    $schema: 'https://opencode.ai/config.json',
    model: config.model,
    // [LAW:single-enforcer] The one shared instruction source, included by absolute path so it
    // loads regardless of the working directory (the repo under review, which we never write to).
    instructions: [agentsPath],
    permission: {
      edit: 'deny',
      bash: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      read: 'allow',
      grep: 'allow',
      glob: 'allow',
      list: 'allow',
      // The engine runs from a scratch cwd OUTSIDE the reviewed repo (see cli.js) and reads the repo
      // by absolute path — which OpenCode gates as `external_directory` and, non-interactively,
      // auto-REJECTS when unstated, killing the session (verified live, 2026-08-27). Allowing it is
      // the read-only design intent above, not a widening: every mutating capability stays denied.
      external_directory: 'allow',
    },
    provider: {
      [providerId]: {
        options: {
          baseURL: config.endpoint.baseUrl,
          apiKey: config.endpoint.credential.value,
        },
        // [LAW:no-silent-failure] OpenCode resolves models against its models.dev catalog and fails a
        // run whose model is not listed (ProviderModelNotFoundError, exit 0 — verified live,
        // 2026-08-27). Production requests exactly this one model, so declare it: a catalog model
        // merges harmlessly, and a non-catalog model (a self-hosted openai-chat endpoint) becomes
        // reachable instead of unreachable-by-construction.
        models: { [modelId]: {} },
      },
    },
    mcp: {
      [MCP_SERVER_NAME]: {
        type: 'local',
        // The collector's already-computed spawn argv: [nodeBinary, distEntry, collectorArg].
        command: [collectorSpawn.command, ...collectorSpawn.args],
        environment: {
          REVIEW_COLLECTOR_RECORDS: collectorSpawn.env.REVIEW_COLLECTOR_RECORDS,
        },
        enabled: true,
      },
    },
  };
}

// [LAW:effects-at-boundaries] The only effect in this adapter: writing the config home. Returns the
// temp dir, which becomes XDG_CONFIG_HOME for the spawned process; OpenCode reads its global config
// from $XDG_CONFIG_HOME/opencode/opencode.json (verified live, 2026-06-14).
function materializeHome({ config, instructionsPath, collector }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-opencode-home-'));
  const cfgDir = path.join(home, 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });

  // [LAW:single-enforcer] Instructions are copied from the one shared source, as AGENTS.md.
  const agentsPath = path.join(cfgDir, 'AGENTS.md');
  fs.copyFileSync(instructionsPath, agentsPath);

  // [LAW:one-source-of-truth] createReviewCollector owns the spawn argv and records path; read its
  // computed spec rather than recomputing the node binary / dist entry reference.
  const mcpCfg = JSON.parse(fs.readFileSync(collector.mcpConfigPath, 'utf8'));
  const collectorSpawn = mcpCfg.mcpServers.review_collector;

  fs.writeFileSync(
    path.join(cfgDir, 'opencode.json'),
    JSON.stringify(buildOpencodeConfig(config, collectorSpawn, agentsPath), null, 2),
    'utf8',
  );
  return home;
}

// [LAW:effects-at-boundaries] Pure: returns a full spawn spec from the validated ReviewConfig.
// The prompt is delivered on stdin (runEngine pipes it) — `opencode run` reads stdin when given no
// message arg (verified live), so no message positional is appended. Model/endpoint/auth all live
// in the config home, so they are not repeated here.
//
// Env is an explicit allowlist — never a process.env spread. OpenCode is an AI agent that can read
// env vars; spreading process.env would expose GITHUB_TOKEN and repo secrets to a prompt-injection
// payload in the diff under review. Only the minimum is passed: PATH (npx resolution), HOME (system
// tools), and XDG_CONFIG_HOME/XDG_DATA_HOME pointing at the isolated config home (so neither the
// developer's real opencode config nor their credentials are read). [LAW:effects-at-boundaries]
//
// OPENCODE_DISABLE_PROJECT_CONFIG isolates the subprocess from the REVIEWED REPO. The review runs
// with cwd = the checked-out repo (the agent reads its working tree), and opencode otherwise walks
// up from cwd loading `./opencode.json` and `.opencode/` — so a malicious PR could plant a project
// config that overrides the model, permission denies, MCP servers, or plugins of the reviewer
// itself (verified: a planted `./opencode.json` took over the run). This flag gates exactly that
// cwd walk, leaving only the isolated XDG_CONFIG_HOME global config in effect. [LAW:effects-at-boundaries]
function buildCommand({ home }) {
  return {
    command: 'npx',
    args: ['-y', OPENCODE_PACKAGE, 'run', '--format', 'json'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: home,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    },
  };
}

// [LAW:no-silent-failure] OpenCode's exit code is NOT a reliable success signal — a model-not-found
// error exits 0 with empty stdout, and a persistent auth/network failure retries internally and
// hangs (caught by the engine timeout), never emitting a clean error. The only trustworthy success
// signal is a terminal `step_finish` event with `reason: "stop"` in the JSONL stream. Its absence —
// empty output, an interrupted turn, or a non-stop terminal reason (length/error) — is surfaced as
// a failure rather than passing as a review with no findings. The "exactly one finish_review"
// invariant downstream (readCollectedReview) is the separate gate on the findings themselves.
function assertSucceeded(stdout) {
  let stopped = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'step_finish' && event.part && event.part.reason === 'stop') {
      stopped = true;
    }
  }
  if (!stopped) {
    throw new Error('OpenCode review did not complete: no step_finish event with reason "stop" was emitted.');
  }
}

// [LAW:effects-at-boundaries] Pure: reads usage from the engine's own JSONL output and returns a
// Usage value, or null when no usage was reported. OpenCode emits one `step_finish` per step (a
// tool-call round is its own step), each carrying its own `tokens` and `cost` — so usage is SUMMED
// across steps, never read from a single event (the values are per-step, not cumulative).
//
// [LAW:dataflow-not-control-flow] OpenCode self-reports USD (its own models.dev price estimate),
// like claude-code and unlike codex — so cost needs no local price table. Cost is available only
// when a numeric cost field was actually observed; a run that emitted no token counts at all is
// reported as no usage (null), and a run with tokens but no cost field yields cost
// {basis:'unpriced', reason:'not-reported'} — never a fabricated $0.00. [LAW:no-silent-failure]
// This gates the figure on an OBSERVED cost exactly as claude-code gates on a present
// total_cost_usd, so a missing figure surfaces "unknown" loudly. [LAW:one-type-per-behavior]
// An observed numeric 0 (a provider OpenCode does not price) is a real {basis:'dollars', usd:0}; the
// reported USD is OpenCode's estimate, so the renderer marks every cost line "est." [FRAMING:representation]
// The basis is always 'dollars': opencode declares credentialKinds ['api-key'], so no opencode run
// can be billed to a subscription and this adapter has no notional arm to reach.
function extractUsage(stdout) {
  let sawTokens = false;
  let sawCost = false;
  let total = emptyTokens();
  let usd = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type !== 'step_finish' || !event.part) continue;
    const { tokens, cost } = event.part;
    if (tokens) {
      sawTokens = true;
      const cache = tokens.cache || {};
      // [LAW:parse-dont-validate] OpenCode's step counts → THE TOKEN RECORD's disjoint classes
      // (src/usage.js). Cache READS are the discounted class; fresh input and cache WRITES are both
      // billed at the full input rate, so they share the miss class. Reasoning tokens are generated
      // output, so they join the visible output rather than any input class.
      total = addTokens(total, {
        inputCacheMiss: (tokens.input ?? 0) + (cache.write ?? 0),
        inputCacheHit: cache.read ?? 0,
        output: (tokens.output ?? 0) + (tokens.reasoning ?? 0),
      });
    }
    if (Number.isFinite(cost)) {
      // [LAW:types-are-the-program] finite, not typeof==='number' (which accepts NaN) — a NaN self-
      // reported cost must not turn the accumulated usd into NaN and thus a non-finite available cost.
      sawCost = true;
      usd += cost;
    }
  }
  if (!sawTokens) return null;
  const cost = sawCost
    ? { basis: 'dollars', usd }
    : { basis: 'unpriced', reason: 'not-reported' };
  return { tokens: total, cost };
}

// [LAW:single-enforcer] The shared transient vocabulary (429/529/network drop) is classified once in
// src/failover.js (classifyTransient); opencode consumes it whole and adds nothing engine-specific.
// OpenCode retries many transient API errors internally, so these signals fire mainly when a failure
// escapes to the captured output text; it doesn't surface Retry-After parseably, so rate-limits fall
// to exponential backoff. [LAW:one-source-of-truth] No local copy of the pattern set to drift.
function classifyError(err, text) {
  return classifyTransient(err, text) ?? err;
}

// [LAW:one-type-per-behavior] The CLI lifecycle is identical across engines, so the adapter is built
// from the shared makeCliAdapter factory; this module supplies only the spawn primitives (the spec).
// The factory exposes the lifted produceReview seam; the spec's primitives stay CLI-internal.
const opencodeAdapter = makeCliAdapter({
  name: 'opencode',
  timeoutMs: OPENCODE_TIMEOUT_MS,
  capabilities: {
    // [LAW:types-are-the-program] Capability declarations are the single source of truth for config
    // validation in src/config.js. An EMPTY reasoningEfforts set is a deliberate, accurate theorem:
    // OpenCode exposes no normalized reasoning-effort control on the `reasoning:` axis (its
    // provider-specific `--variant` flag is a different axis, out of scope), so any `reasoning:` on
    // an opencode config is rejected at load — never silently ignored. [LAW:no-silent-failure]
    reasoningEfforts: [],
    // The OpenAI/Anthropic-compatible provider protocols OpenCode can front via an endpoint override.
    apiTypes: ['openai-chat', 'openai-responses', 'anthropic-messages'],
    // OpenCode authenticates a provider override by baseURL + apiKey; it has no channel for an OAuth
    // credential, so that kind is rejected at load rather than written into opencode.json.
    credentialKinds: ['api-key'],
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
// (generated opencode.json, success parse, usage parse, error classification) — they are NOT part
// of the public adapter interface. [LAW:behavior-not-structure]
module.exports = {
  opencodeAdapter,
  OPENCODE_TIMEOUT_MS,
  MCP_SERVER_NAME,
  buildOpencodeConfig,
  materializeHome,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
};
