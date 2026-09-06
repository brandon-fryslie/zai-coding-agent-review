'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const core = require('@actions/core');
const {
  codexAdapter,
  buildConfigToml,
  CODEX_TIMEOUT_MS,
  buildCommand,
  appServerSession,
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

  test('args run the app-server over stdio — the transport that reports usage per model request', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.ok(args.includes('app-server'), 'app-server subcommand missing');
    assert.equal(args.includes('exec'), false, 'exec --json reports usage only as a turn total');
  });

  test('no sandbox/approval bypass flag — the collector approval is answered on the protocol, sandbox intact', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, home: MOCK_HOME });
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
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
  test('does not throw when the turn completed', () => {
    assert.doesNotThrow(() => assertSucceeded({ turn: { status: 'completed', error: null }, requests: [] }));
  });

  test('throws when the turn failed, carrying the message and the typed error class', () => {
    const turn = { status: 'failed', error: { message: '401 Unauthorized', codexErrorInfo: 'unauthorized' } };
    assert.throws(() => assertSucceeded({ turn, requests: [] }), /Codex review failed: 401 Unauthorized \("unauthorized"\)/);
  });

  test('throws when the turn failed with no error at all', () => {
    assert.throws(() => assertSucceeded({ turn: { status: 'failed', error: null }, requests: [] }), /Codex review failed: no error reported/);
  });

  test('an interrupted turn is not a success', () => {
    // Codex can settle a turn as interrupted (a cancel, an internal stop) with no findings collected;
    // treating anything but 'completed' as success would silently produce an empty review.
    assert.throws(() => assertSucceeded({ turn: { status: 'interrupted', error: null }, requests: [] }), /Codex review interrupted/);
  });

  test('a quota wall reported as the typed class classifies transient through classifyError', () => {
    const turn = { status: 'failed', error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' } };
    let err;
    try { assertSucceeded({ turn, requests: [] }); } catch (e) { err = e; }
    assert.ok(classifyError(err, err.message) instanceof TransientError);
  });
});

// --- appServerSession ---

// A fake app-server: `serve(msg, io)` answers each client message with the wire lines a real codex
// would emit, on a later tick as a pipe would. The io mirrors what runEngine hands a session.
// [LAW:behavior-not-structure] Every assertion is on the wire (what the session sent) or on the
// record it resolved with.
function fakeIo(serve) {
  const lines = new EventEmitter();
  let closedResolve;
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const io = {
    sent: [],
    ended: false,
    write: text => {
      for (const raw of text.split('\n').filter(Boolean)) {
        const msg = JSON.parse(raw);
        io.sent.push(msg);
        setImmediate(() => { for (const reply of serve(msg, io)) lines.emit('line', JSON.stringify(reply)); });
      }
    },
    end: () => { io.ended = true; setImmediate(() => io.close()); },
    close: () => { lines.emit('close'); closedResolve('<stdout>'); },
    lines,
    closed,
  };
  return io;
}

const usageOf = (inputTokens, cachedInputTokens, outputTokens) =>
  ({ totalTokens: inputTokens + outputTokens, inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 0 });

// The turn codex 0.142.3 emits, as observed live 2026-09-06: a response to each request, one
// tokenUsage notification per model request, any server requests, then turn/completed.
function codexLike({ usage = [], serverRequests = [], outcome = { status: 'completed', error: null } } = {}) {
  return msg => {
    if (msg.method === 'initialize') return [{ id: msg.id, result: { userAgent: 'codex/0.142.3' } }];
    if (msg.method === 'thread/start') return [{ id: msg.id, result: { thread: { id: 'thread-1' }, cwd: '/scratch' } }];
    if (msg.method === 'turn/start') {
      return [
        { id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } },
        ...usage.map(last => ({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last, total: last, modelContextWindow: 258400 } } })),
        ...serverRequests,
        { method: 'item/agentMessage/delta', params: { delta: 'noise' } },
        { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', ...outcome } } },
      ];
    }
    return [];
  };
}

const collectorApproval = {
  id: 0,
  method: 'mcpServer/elicitation/request',
  params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'review_collector', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'finish_review' } },
};

async function captureWarnings(fn) {
  const original = core.warning;
  const warnings = [];
  core.warning = msg => warnings.push(msg);
  try { await fn(); } finally { core.warning = original; }
  return warnings;
}

describe('appServerSession — the conversation with codex app-server', () => {
  test('handshakes, opens a thread, starts the turn with the prompt, and resolves with the completed turn and every request usage', async () => {
    const usage = [usageOf(16_236, 2_432, 145), usageOf(16_755, 2_432, 32)];
    const io = fakeIo(codexLike({ usage, serverRequests: [collectorApproval] }));
    const record = await appServerSession(io, 'Review this diff.');

    assert.deepEqual(record.turn, { id: 'turn-1', status: 'completed', error: null });
    assert.deepEqual(record.requests, usage);
    const methods = io.sent.map(m => m.method);
    assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'thread/start', 'turn/start']);
    assert.equal(io.sent[1].id, undefined, 'initialized is a notification, not a request');
    const turnStart = io.sent.find(m => m.method === 'turn/start');
    assert.deepEqual(turnStart.params, { threadId: 'thread-1', input: [{ type: 'text', text: 'Review this diff.' }] });
    assert.equal(io.ended, true, 'the session ends stdin so the server exits');
  });

  test("the collector's tool-call approval is granted — the gate exec needed the bypass flag for", async () => {
    const io = fakeIo(codexLike({ serverRequests: [collectorApproval] }));
    const warnings = await captureWarnings(() => appServerSession(io, 'p'));
    const reply = io.sent.find(m => m.id === 0);
    assert.deepEqual(reply, { jsonrpc: '2.0', id: 0, result: { action: 'accept' } });
    assert.deepEqual(warnings, []);
  });

  test('any other server request is refused with a JSON-RPC error and announced, never granted or left hanging', async () => {
    const foreign = [
      { id: 5, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i' } },
      { id: 6, method: 'mcpServer/elicitation/request', params: { serverName: 'some_other_server', _meta: { codex_approval_kind: 'mcp_tool_call' } } },
    ];
    const io = fakeIo(codexLike({ serverRequests: foreign }));
    const warnings = await captureWarnings(() => appServerSession(io, 'p'));
    for (const id of [5, 6]) {
      const reply = io.sent.find(m => m.id === id);
      assert.ok(reply.error, `request ${id} must be answered with an error`);
      assert.equal(reply.result, undefined);
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /item\/commandExecution\/requestApproval/);
  });

  test('a failed turn resolves with its status and error for assertSucceeded to judge', async () => {
    const outcome = { status: 'failed', error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' } };
    const io = fakeIo(codexLike({ outcome }));
    const record = await appServerSession(io, 'p');
    assert.equal(record.turn.status, 'failed');
    assert.throws(() => assertSucceeded(record), /usage limit reached/);
  });

  test('rejects when the server exits before the turn completes', async () => {
    const io = fakeIo((msg, io) => {
      if (msg.method === 'turn/start') { setImmediate(() => io.close()); return [{ id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } }]; }
      return codexLike()(msg);
    });
    await assert.rejects(appServerSession(io, 'p'), /exited before turn\/completed/);
  });

  test('rejects with the failing method when a request is answered with an error', async () => {
    const io = fakeIo(msg => msg.method === 'thread/start'
      ? [{ id: msg.id, error: { code: -32000, message: 'model_not_found' } }]
      : codexLike()(msg));
    await assert.rejects(appServerSession(io, 'p'), /thread\/start failed: model_not_found/);
  });

  test('rejects when the stream closes with a request still unanswered', async () => {
    const io = fakeIo((msg, io) => {
      if (msg.method === 'initialize') setImmediate(() => io.close());
      return [];
    });
    await assert.rejects(appServerSession(io, 'p'), /initialize never answered/);
  });

  // [LAW:parse-dont-validate] A notification the session cannot read is the session's loud failure,
  // named with the method and payload — never an exception thrown inside the stream callback.
  test('rejects, naming the method, when a usage notification carries no request usage', async () => {
    const io = fakeIo(msg => msg.method === 'turn/start'
      ? [
        { id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } },
        { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { total: usageOf(1, 0, 1) } } },
      ]
      : codexLike()(msg));
    await assert.rejects(appServerSession(io, 'p'), /thread\/tokenUsage\/updated carried no request usage/);
  });

  test('rejects when turn/completed carries no turn', async () => {
    const io = fakeIo(msg => msg.method === 'turn/start'
      ? [
        { id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } },
        { method: 'turn/completed', params: { threadId: 'thread-1' } },
      ]
      : codexLike()(msg));
    await assert.rejects(appServerSession(io, 'p'), /turn\/completed carried no turn/);
  });

  test('a late response to no pending request is dropped, not refused as a server request', async () => {
    const io = fakeIo(msg => msg.method === 'turn/start'
      ? [
        { id: msg.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } },
        { id: 999, result: { stale: true } },
        { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } },
      ]
      : codexLike()(msg));
    const warnings = await captureWarnings(() => appServerSession(io, 'p'));
    assert.equal(io.sent.find(m => m.id === 999), undefined, 'nothing is sent back for id 999');
    assert.deepEqual(warnings, []);
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

  test('apiTypes contains only "openai-responses"', () => {
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
