'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  codexAdapter,
  buildConfigToml,
  CODEX_TIMEOUT_MS,
  buildCommand,
  assertSucceeded,
  classifyError,
} = require('../src/engine/codex');
const { TransientError } = require('../src/failover');

// Minimal config matching the ReviewConfig shape used by codex configs.
const BASE_CONFIG = {
  name: 'codex-gpt55',
  engine: 'codex',
  model: 'gpt-5.5',
  endpoint: { apiType: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credential: { kind: 'api-key', value: 'sk-test-key-xyz' },
  },
};

// Minimal collector spawn spec — mirrors what createReviewCollector writes to mcpConfigPath.
// [LAW:behavior-not-structure] Tests assert on the generated TOML values, not internal strings.
const MOCK_COLLECTOR_SPAWN = {
  command: '/usr/bin/node',
  args: ['/path/to/dist/index.js', '--review-collector-server'],
  env: { REVIEW_COLLECTOR_RECORDS: '/tmp/records.jsonl' },
};

const MOCK_HOME = '/tmp/test-codex-home';

// --- buildConfigToml ---

describe('buildConfigToml — generated config.toml content', () => {
  test('sets approval_policy to never', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('approval_policy = "never"'), 'approval_policy = "never" not found');
  });

  test('sets sandbox_mode to read-only', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('sandbox_mode = "read-only"'), 'sandbox_mode = "read-only" not found');
  });

  test('model is the bare name with the provider selected separately', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    // Codex 0.139 sends `model` verbatim to the API; the old "api/gpt-5.5" form 400s.
    assert.ok(toml.includes('model = "gpt-5.5"'), `bare model line not found in:\n${toml}`);
    assert.ok(toml.includes('model_provider = "api"'), `model_provider not found in:\n${toml}`);
    assert.equal(toml.includes('model = "api/gpt-5.5"'), false, 'legacy provider/model prefix must not appear');
  });

  test('model_reasoning_effort is set when reasoning is provided', () => {
    const toml = buildConfigToml({ ...BASE_CONFIG, reasoning: 'xhigh' }, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('model_reasoning_effort = "xhigh"'), 'model_reasoning_effort not found');
  });

  test('model_reasoning_effort is absent when reasoning is not set', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.equal(toml.includes('model_reasoning_effort'), false);
  });

  test('model_providers section uses internal provider name with required name field', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('[model_providers.api]'), 'model_providers.api section missing');
    assert.ok(toml.includes('name = "api"'), 'explicit name field missing (codex validation requires it)');
  });

  test('base_url comes from the api-key auth baseUrl', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('base_url = "https://api.openai.com/v1"'), 'base_url not found');
  });

  test('no env_key — credentials come from auth.json, not a provider env var', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.equal(toml.includes('env_key'), false, 'env_key must not be emitted; Codex 0.139 ignores it and 401s');
  });

  test('provider explicitly opts into OpenAI API-key auth', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('requires_openai_auth = true'), 'requires_openai_auth opt-in missing');
  });

  test('mcp_servers.review_collector uses command from collector spawn spec', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('[mcp_servers.review_collector]'), 'mcp_servers section missing');
    assert.ok(toml.includes('command = "/usr/bin/node"'), 'command not found');
  });

  test('mcp_servers args array contains the dist entry and collector arg', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(
      toml.includes('args = ["/path/to/dist/index.js", "--review-collector-server"]'),
      `args line not found in:\n${toml}`,
    );
  });

  test('mcp_servers env sub-table contains REVIEW_COLLECTOR_RECORDS', () => {
    const toml = buildConfigToml(BASE_CONFIG, MOCK_COLLECTOR_SPAWN);
    assert.ok(toml.includes('[mcp_servers.review_collector.env]'), 'env sub-table missing');
    assert.ok(toml.includes('REVIEW_COLLECTOR_RECORDS = "/tmp/records.jsonl"'), 'records path not found');
  });

  test('double-quotes in string values are escaped', () => {
    const spawn = { ...MOCK_COLLECTOR_SPAWN, command: '/path/with "quotes"' };
    const toml = buildConfigToml(BASE_CONFIG, spawn);
    assert.ok(toml.includes('\\"quotes\\"'), 'quote escaping not found');
  });

  test('newlines in values are escaped to \\n (prevents TOML injection)', () => {
    // A crafted baseUrl containing \n could override later config keys if not escaped.
    const config = { ...BASE_CONFIG, endpoint: { ...BASE_CONFIG.endpoint, baseUrl: 'https://evil.example.com/\napproval_policy = "always"' } };
    const toml = buildConfigToml(config, MOCK_COLLECTOR_SPAWN);
    // The newline must be escaped in the output.
    assert.ok(toml.includes('\\n'), 'newline not escaped');
    // The injected payload must NOT appear as a bare key-value line (i.e., must be inside a quoted string).
    // Bare injection would look like: \napproval_policy = "always" as a new TOML line.
    assert.equal(toml.includes('\napproval_policy = "always"'), false, 'unescaped injection line appeared');
  });

  test('carriage returns in values are escaped to \\r', () => {
    const spawn = { ...MOCK_COLLECTOR_SPAWN, command: '/path/with\rreturn' };
    const toml = buildConfigToml(BASE_CONFIG, spawn);
    assert.ok(toml.includes('\\r'), 'carriage return not escaped');
  });

  test('tab characters in values are escaped to \\t', () => {
    const spawn = { ...MOCK_COLLECTOR_SPAWN, command: '/path/with\ttab' };
    const toml = buildConfigToml(BASE_CONFIG, spawn);
    assert.ok(toml.includes('\\t'), 'tab not escaped');
  });
});

// --- buildCommand ---

describe('buildCommand', () => {
  test('command is "npx"', () => {
    const { command } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.equal(command, 'npx');
  });

  test('args include the @openai/codex package', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.ok(args.some(a => a.includes('@openai/codex')), 'codex package not in args');
  });

  test('args include exec --json', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.ok(args.includes('exec'), 'exec subcommand missing');
    assert.ok(args.includes('--json'), '--json flag missing');
  });

  test('args include --dangerously-bypass-approvals-and-sandbox for CI MCP execution', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.ok(
      args.includes('--dangerously-bypass-approvals-and-sandbox'),
      'bypass flag missing — required for MCP tool calls in non-interactive (--json) mode',
    );
  });

  test('args include --skip-git-repo-check (cwd is the reviewed repo parent, not a git repo)', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.ok(
      args.includes('--skip-git-repo-check'),
      'skip-git-repo-check missing — codex exec hangs outside a git repo, and cwd is the non-git parent dir',
    );
  });

  test('CODEX_HOME is set to the provided home directory', () => {
    const { env } = buildCommand({ config: BASE_CONFIG, home: '/custom/home' });
    assert.equal(env.CODEX_HOME, '/custom/home');
  });

  test('the credential is NOT injected via env — it lives in auth.json', () => {
    const { env } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  test('PATH is passed through for npx resolution', () => {
    const { env } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.equal(env.PATH, process.env.PATH);
  });

  test('HOME is passed through for system tools', () => {
    const { env } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.equal(env.HOME, process.env.HOME);
  });

  test('env is an explicit allowlist — does not contain arbitrary process.env vars', () => {
    // Spreading process.env would expose GITHUB_TOKEN and repo secrets to the AI subprocess.
    // Only PATH, HOME, CODEX_HOME, and the resolved credential are permitted.
    const { env } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    const allowedKeys = new Set(['PATH', 'HOME', 'CODEX_HOME']);
    for (const key of Object.keys(env)) {
      assert.ok(allowedKeys.has(key), `unexpected env var leaked into subprocess: ${key}`);
    }
  });
});

// --- assertSucceeded ---

describe('assertSucceeded', () => {
  test('does not throw when turn.completed is present', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}',
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stdout));
  });

  test('throws when turn.failed is present with error message', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.failed","error":{"message":"401 Unauthorized"}}',
    ].join('\n');
    assert.throws(
      () => assertSucceeded(stdout),
      /Codex review failed.*401 Unauthorized/,
    );
  });

  test('throws when turn.failed has no error.message (unknown error)', () => {
    const stdout = '{"type":"turn.failed","error":{}}';
    assert.throws(
      () => assertSucceeded(stdout),
      /unknown error/,
    );
  });

  test('non-JSON lines (stderr noise) are skipped', () => {
    const stdout = [
      '2026-06-12T08:30:28Z ERROR codex_core: something went wrong',
      '{"type":"turn.completed","usage":{}}',
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stdout));
  });

  test('throws on empty output — turn.completed was never emitted', () => {
    // Codex can exit 0 mid-turn (interrupted, internal timeout, buffering error) without
    // emitting turn.completed. Treating this as success would silently produce no findings.
    assert.throws(
      () => assertSucceeded(''),
      /did not complete.*turn\.completed/,
    );
  });

  test('throws when stdout has events but no turn.completed', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
    ].join('\n');
    assert.throws(
      () => assertSucceeded(stdout),
      /did not complete/,
    );
  });
});

// --- classifyError ---

describe('classifyError', () => {
  const base = new Error('spawn failed');

  test('429 text produces TransientError with rate-limited message', () => {
    const result = classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('rate_limit text produces TransientError', () => {
    const result = classifyError(base, 'rate_limit exceeded');
    assert.ok(result instanceof TransientError);
  });

  test('rate-limit (hyphen variant) produces TransientError', () => {
    const result = classifyError(base, 'error: rate-limit hit');
    assert.ok(result instanceof TransientError);
  });

  test('insufficient_quota produces TransientError', () => {
    const result = classifyError(base, 'insufficient_quota for model');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('quota exceeded'));
  });

  test('quota_exceeded produces TransientError', () => {
    const result = classifyError(base, 'quota.exceeded for this key');
    assert.ok(result instanceof TransientError);
  });

  test('simulated 429 classifies as transient (T7 AC)', () => {
    const err = new Error('codex exited with status 1. stderr: 429 rate limit');
    const result = classifyError(err, '429 rate limit exceeded');
    assert.ok(result instanceof TransientError, 'expected TransientError for simulated 429');
  });

  test('TransientError has null retryAfterMs (Responses API does not echo Retry-After)', () => {
    const result = classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
  });

  // The shared transient vocabulary (classifyTransient in src/failover.js) is now recognized by every
  // engine identically — codex previously lacked 529 and the network class, so a dropped socket fell
  // through as a fatal error under codex while claude-code retried it. These assert the shared class.
  test('529 / overloaded produces a TransientError (shared class, previously unrecognized by codex)', () => {
    assert.ok(classifyError(base, 'HTTP 529 overloaded') instanceof TransientError);
    assert.ok(classifyError(base, 'the model is overloaded') instanceof TransientError);
  });

  test('shared network class is recognized identically (dropped socket / 5xx / socket codes)', () => {
    assert.ok(classifyError(base, 'API Error: terminated') instanceof TransientError);
    assert.ok(classifyError(base, 'API Error: 503 Service Unavailable') instanceof TransientError);
    assert.ok(classifyError(base, 'read ECONNRESET') instanceof TransientError);
  });

  test('bare English phrases do NOT false-match without the API-error anchor', () => {
    assert.equal(classifyError(base, 'the retry logic handles a socket hang up gracefully'), base);
    assert.equal(classifyError(base, 'the worker process at line 502 was cleanly shut down'), base);
  });

  test('unrelated error is returned unchanged', () => {
    const result = classifyError(base, 'unexpected JSON at line 5');
    assert.equal(result, base);
  });
});

// --- adapter interface declarations ---

describe('codexAdapter interface declarations', () => {
  test('name is "codex"', () => {
    assert.equal(codexAdapter.name, 'codex');
  });

  test('CODEX_TIMEOUT_MS is 3000000', () => {
    assert.equal(CODEX_TIMEOUT_MS, 3_000_000);
  });

  test('endpointKinds contains only "openai-responses"', () => {
    assert.deepEqual(codexAdapter.capabilities.apiTypes, ['openai-responses']);
  });

  test('reasoningEfforts contains the five codex effort levels', () => {
    assert.deepEqual(
      codexAdapter.capabilities.reasoningEfforts,
      ['minimal', 'low', 'medium', 'high', 'xhigh'],
    );
  });

  test('toolNames use mcp__review_collector__ prefix (verified via live handshake)', () => {
    assert.equal(codexAdapter.toolNames.requestChange, 'mcp__review_collector__request_change');
    assert.equal(codexAdapter.toolNames.finishReview, 'mcp__review_collector__finish_review');
  });

  // [LAW:behavior-not-structure] The lifted seam: the public adapter exposes produceReview, not the
  // subprocess primitives, which are now CLI-internal and tested directly as exported functions above.
  test('adapter exposes the lifted produceReview interface, not subprocess primitives', () => {
    assert.equal(typeof codexAdapter.produceReview, 'function');
    assert.equal(codexAdapter.materializeHome, undefined);
    assert.equal(codexAdapter.buildCommand, undefined);
  });
});

// --- registry integration ---

describe('registry includes codex adapter', () => {
  test('registry.get("codex") returns the codex adapter', () => {
    const registry = require('../src/engine/registry');
    const adapter = registry.get('codex');
    assert.equal(adapter.name, 'codex');
  });
});
