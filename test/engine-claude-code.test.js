'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  claudeCodeAdapter,
  ZAI_ANTHROPIC_BASE_URL,
  CLAUDE_TIMEOUT_MS,
  buildCommand,
  classifyError,
  assertSucceeded,
  extractUsage,
  parseResultEnvelope,
} = require('../src/engine/claude-code');

// [LAW:verifiable-goals] AC for T3: existing ZAI_* inputs produce a byte-identical
// claude invocation (args + env) to the pre-refactor runClaudeCode + buildClaudeArgs.
// These fixtures are the machine-verifiable record of what "byte-identical" means.

const MOCK_COLLECTOR = { mcpConfigPath: '/tmp/test-mcp-config.json' };
const MOCK_HOME = '/tmp/test-reviewer-home';
const BASE_CONFIG = {
  name: 'zai-compat',
  engine: 'claude-code',
  model: 'claude-sonnet-4-6',
  endpoint: {
    kind: 'anthropic-messages',
    auth: { method: 'api-key', baseUrl: ZAI_ANTHROPIC_BASE_URL, credential: 'test-api-key-xyz' },
  },
};

// The same engine and model reached through the OTHER credential channel: a Claude Pro/Max
// subscription token. No baseUrl exists on this variant to set.
const SUBSCRIPTION_CONFIG = {
  name: 'claude-subscription-default',
  engine: 'claude-code',
  model: 'claude-sonnet-5',
  endpoint: {
    kind: 'anthropic-messages',
    auth: { method: 'subscription', credential: 'sk-ant-oat01-test-token' },
  },
};

describe('buildCommand — canonical claude-code args', () => {
  test('command is always "npx"', () => {
    const { command } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(command, 'npx');
  });

  test('args match the exact order and values', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });

    // Canonical arg sequence — stream-json --verbose so every transcript carries thinking/tool calls
    assert.deepEqual(args, [
      '-y',
      '@anthropic-ai/claude-code@2.1.0',
      '-p',
      '--verbose',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--tools',
      'Read,Grep,Glob',
      '--allowedTools',
      'Read,Grep,Glob,mcp__review_collector__request_change,mcp__review_collector__finish_review,mcp__review_collector__add_scope,mcp__review_collector__assess_dependency',
      '--disallowedTools',
      'Bash,Edit,Write,WebFetch,WebSearch',
      '--mcp-config',
      '/tmp/test-mcp-config.json',
      '--strict-mcp-config',
      '--permission-mode',
      'dontAsk',
      '--model',
      'claude-sonnet-4-6',
      'Review the pull request instructions and diff from stdin.',
    ]);
  });

  test('omits --model when model is empty string', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, model: '' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--model'), false);
    assert.equal(args.at(-1), 'Review the pull request instructions and diff from stdin.');
  });

  test('omits --append-system-prompt when systemPrompt is absent', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args.includes('--append-system-prompt'), false);
  });

  test('--append-system-prompt appears before the prompt string when set', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, systemPrompt: 'Focus on security.' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    const idx = args.indexOf('--append-system-prompt');
    assert.ok(idx !== -1, '--append-system-prompt missing');
    assert.equal(args[idx + 1], 'Focus on security.');
    assert.equal(args.at(-1), 'Review the pull request instructions and diff from stdin.');
  });

  test('mcp-config arg uses collector.mcpConfigPath', () => {
    const { args } = buildCommand({
      config: BASE_CONFIG,
      collector: { mcpConfigPath: '/custom/path/mcp.json' },
      home: MOCK_HOME,
    });
    const idx = args.indexOf('--mcp-config');
    assert.ok(idx !== -1);
    assert.equal(args[idx + 1], '/custom/path/mcp.json');
  });
});

describe('buildCommand — env is an explicit allowlist', () => {
  test('HOME is set to the provided home directory', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: '/custom/home/dir',
    });
    assert.equal(env.HOME, '/custom/home/dir');
  });

  test('ANTHROPIC_AUTH_TOKEN comes from the api-key auth credential', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'test-api-key-xyz');
  });

  test('ANTHROPIC_BASE_URL comes from the api-key auth baseUrl (ZAI URL for compat shim)', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  });

  test('ANTHROPIC_MODEL is set to config.model', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-4-6');
  });

  test('API_TIMEOUT_MS is set to the string form of CLAUDE_TIMEOUT_MS (3000000)', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.API_TIMEOUT_MS, '3000000');
  });

  test('CLAUDE_CODE_SKIP_PROMPT_HISTORY is "1"', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
  });

  test('NO_COLOR is "1"', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.NO_COLOR, '1');
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is absent when reasoning is not set', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal('CLAUDE_CODE_EFFORT_LEVEL' in env, false);
  });

  test('CLAUDE_CODE_EFFORT_LEVEL is set from config.reasoning when present', () => {
    const { env } = buildCommand({
      config: { ...BASE_CONFIG, reasoning: 'high' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  });

  test('PATH is passed through from the runner env', () => {
    const { env } = buildCommand({
      config: BASE_CONFIG,
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(env.PATH, process.env.PATH);
  });

  test('env is an explicit allowlist — does not leak arbitrary process.env vars', () => {
    // Spreading process.env would expose GITHUB_TOKEN and repo secrets to the AI subprocess.
    // Only the npx/node runner vars, the temp HOME, and the ANTHROPIC_*/CLAUDE_CODE_* values
    // this adapter owns are permitted. [LAW:single-enforcer]
    const { env } = buildCommand({
      config: { ...BASE_CONFIG, reasoning: 'high' },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    const allowedKeys = new Set([
      'PATH', 'TMPDIR', 'npm_config_cache', 'HOME',
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN',
      'API_TIMEOUT_MS', 'CLAUDE_CODE_SKIP_PROMPT_HISTORY', 'NO_COLOR',
      'CLAUDE_CODE_EFFORT_LEVEL',
    ]);
    for (const key of Object.keys(env)) {
      assert.ok(allowedKeys.has(key), `unexpected env var leaked into subprocess: ${key}`);
    }
  });

  test('a GITHUB_TOKEN in the runner env never reaches the child', () => {
    // The exact exfiltration the isolation posture exists to prevent: a runner secret sitting in
    // process.env must not be handed to the reviewer subprocess. Inject it, then assert absence.
    const hadToken = 'GITHUB_TOKEN' in process.env;
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghs_secret_must_not_leak';
    try {
      const { env } = buildCommand({
        config: BASE_CONFIG,
        collector: MOCK_COLLECTOR,
        home: MOCK_HOME,
      });
      assert.equal('GITHUB_TOKEN' in env, false);
    } finally {
      if (hadToken) process.env.GITHUB_TOKEN = prior;
      else delete process.env.GITHUB_TOKEN;
    }
  });
});

// [LAW:verifiable-goals] AC for zai-billing-xl0.1. The two auth variants produce two byte-exact envs,
// asserted whole rather than field by field: what matters is not only what IS set but what is NOT,
// and a whole-object assertion is the only form that fails when a var quietly reappears.
describe('buildCommand — the auth variant decides the credential channel, byte-exactly', () => {
  const RUNNER_VARS = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    npm_config_cache: process.env.npm_config_cache,
  };
  const CONSTANTS = {
    API_TIMEOUT_MS: String(CLAUDE_TIMEOUT_MS),
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    NO_COLOR: '1',
  };

  test('api-key: the env is byte-identical to the pre-auth-union set', () => {
    const { env } = buildCommand({ config: BASE_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
    assert.deepEqual(env, {
      ...RUNNER_VARS,
      HOME: MOCK_HOME,
      ANTHROPIC_AUTH_TOKEN: 'test-api-key-xyz',
      ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_BASE_URL,
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ...CONSTANTS,
    });
  });

  test('subscription: CLAUDE_CODE_OAUTH_TOKEN is the ONLY credential var, and there is no base URL', () => {
    const { env } = buildCommand({ config: SUBSCRIPTION_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
    assert.deepEqual(env, {
      ...RUNNER_VARS,
      HOME: MOCK_HOME,
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-token',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ...CONSTANTS,
    });
  });

  test('subscription: none of the three vars that OUTRANK the OAuth token are set', () => {
    // Stated separately from the deepEqual because the reason is not self-evident from it. The CLI's
    // precedence is ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN,
    // and it resolves SILENTLY: any of these present means the run bills an API key while the operator
    // believes the subscription paid for it. ANTHROPIC_BASE_URL is here too — it redirects the very
    // endpoint the OAuth token is scoped to.
    const { env } = buildCommand({ config: SUBSCRIPTION_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
      assert.equal(key in env, false, `${key} must be absent for a subscription run — it outranks CLAUDE_CODE_OAUTH_TOKEN`);
    }
  });

  test('an ambient ANTHROPIC_API_KEY on the runner never reaches a subscription run', () => {
    // The precedence trap arriving from OUTSIDE the config: a runner that happens to export an API key
    // would hijack the subscription run if the env were a process.env spread. The allowlist forbids it.
    const had = 'ANTHROPIC_API_KEY' in process.env;
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ambient-must-not-win';
    try {
      const { env } = buildCommand({ config: SUBSCRIPTION_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
      assert.equal('ANTHROPIC_API_KEY' in env, false);
    } finally {
      if (had) process.env.ANTHROPIC_API_KEY = prior;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test('--bare is never passed: it does not read CLAUDE_CODE_OAUTH_TOKEN', () => {
    for (const config of [BASE_CONFIG, SUBSCRIPTION_CONFIG]) {
      const { args } = buildCommand({ config, collector: MOCK_COLLECTOR, home: MOCK_HOME });
      assert.equal(args.includes('--bare'), false, `--bare breaks subscription auth silently (config '${config.name}')`);
    }
  });

  test('an unknown auth method fails loudly instead of spawning with no credential', () => {
    assert.throws(
      () => buildCommand({
        config: { ...BASE_CONFIG, endpoint: { kind: 'anthropic-messages', auth: { method: 'oauth-device-flow', credential: 'x' } } },
        collector: MOCK_COLLECTOR,
        home: MOCK_HOME,
      }),
      { message: /no auth env mapping for method 'oauth-device-flow'.*api-key, subscription/ },
    );
  });
});

describe('claudeCodeAdapter interface declarations', () => {
  test('name is "claude-code"', () => {
    assert.equal(claudeCodeAdapter.name, 'claude-code');
  });

  test('CLAUDE_TIMEOUT_MS is 3000000 (50 minutes)', () => {
    assert.equal(CLAUDE_TIMEOUT_MS, 3_000_000);
  });

  test('endpointKinds contains only "anthropic-messages"', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.endpointKinds, ['anthropic-messages']);
  });

  test('reasoningEfforts contains the four claude effort levels', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.reasoningEfforts, ['low', 'medium', 'high', 'max']);
  });

  test('authMethods declares both credential channels this engine can actually spawn', () => {
    assert.deepEqual(claudeCodeAdapter.capabilities.authMethods, ['api-key', 'subscription']);
  });

  test('toolNames reference mcp__review_collector__ prefix', () => {
    assert.equal(claudeCodeAdapter.toolNames.requestChange, 'mcp__review_collector__request_change');
    assert.equal(claudeCodeAdapter.toolNames.finishReview, 'mcp__review_collector__finish_review');
  });

  // [LAW:behavior-not-structure] The lifted seam: the public adapter exposes produceReview, not the
  // subprocess primitives (buildCommand/materializeHome/...), which are now CLI-internal and tested
  // directly as exported functions above.
  test('adapter exposes the lifted produceReview interface, not subprocess primitives', () => {
    assert.equal(typeof claudeCodeAdapter.produceReview, 'function');
    assert.equal(claudeCodeAdapter.materializeHome, undefined);
    assert.equal(claudeCodeAdapter.buildCommand, undefined);
  });
});

describe('classifyError', () => {
  const base = new Error('spawn failed');

  test('429 text produces TransientError', () => {
    const { TransientError } = require('../src/failover');
    const result = classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('529 text produces TransientError with null retryAfterMs', () => {
    const { TransientError } = require('../src/failover');
    const result = classifyError(base, 'HTTP 529 overloaded');
    assert.ok(result instanceof TransientError);
    assert.equal(result.retryAfterMs, null);
  });

  test("'API Error: terminated' produces a TransientError (the observed dropped-socket case)", () => {
    const { TransientError } = require('../src/failover');
    // The exact shape assertSucceeded builds when the terminal envelope is is_error.
    const result = classifyError(base, 'Claude Code review failed: API Error: terminated');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('connection error'));
  });

  test('Node socket error codes are transient (ECONNRESET / ETIMEDOUT / ENOTFOUND)', () => {
    const { TransientError } = require('../src/failover');
    assert.ok(classifyError(base, 'read ECONNRESET') instanceof TransientError);
    assert.ok(classifyError(base, 'connect ETIMEDOUT 1.2.3.4:443') instanceof TransientError);
    assert.ok(classifyError(base, 'getaddrinfo ENOTFOUND api.example.com') instanceof TransientError);
  });

  test('endpoint 5xx / socket-hang-up / fetch-failed are transient IN the API-error context', () => {
    const { TransientError } = require('../src/failover');
    assert.ok(classifyError(base, 'API Error: 503 Service Unavailable') instanceof TransientError);
    assert.ok(classifyError(base, 'API Error: socket hang up') instanceof TransientError);
    assert.ok(classifyError(base, 'API Error: fetch failed') instanceof TransientError);
  });

  test('bare English phrases (socket hang up / fetch failed) do NOT false-match without the API-error anchor', () => {
    // The reviewed diff or a model's prose may mention these; only the endpoint's own
    // `API Error: …` framing makes them a real transient signal. Unanchored, they must NOT match.
    assert.equal(classifyError(base, 'the retry logic handles a socket hang up gracefully'), base);
    assert.equal(classifyError(base, 'we log when fetch failed in the client'), base);
  });

  test('unrelated error is returned unchanged', () => {
    const result = classifyError(base, 'unexpected token at line 42');
    assert.equal(result, base);
  });

  test('a bare status-like number in review content does NOT false-match as transient', () => {
    // No API-error / socket-code context — a diff mentioning "line 502" or "terminated the process"
    // must stay non-transient so a real fatal error is not laundered into an endless retry.
    assert.equal(classifyError(base, 'the worker process at line 502 was cleanly shut down'), base);
  });
});

// claude-code always emits the streaming JSONL form so the full reasoning/tool flow is captured in
// every session transcript — there is no opt-in flag and no plain-json path.
describe('buildCommand — canonical stream-json output format', () => {
  test('always uses --verbose --output-format stream-json (no debug field)', () => {
    const { args } = buildCommand({ config: BASE_CONFIG, collector: MOCK_COLLECTOR, home: MOCK_HOME });
    assert.ok(args.includes('--verbose'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    // stream-json requires --verbose to precede the format selection
    assert.ok(args.indexOf('--verbose') < args.indexOf('--output-format'));
  });

  test('a debug field on the config does not change the format (mode is gone)', () => {
    const { args } = buildCommand({
      config: { ...BASE_CONFIG, debug: false },
      collector: MOCK_COLLECTOR,
      home: MOCK_HOME,
    });
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  });
});

// parseResultEnvelope normalizes BOTH output formats to one envelope so assertSucceeded/extractUsage
// stay uniform. The single-object (default) path must behave exactly as parseJsonEnvelope did.
describe('parseResultEnvelope — robust to json and stream-json', () => {
  const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.01, usage: { input_tokens: 100, output_tokens: 10 } };

  test('single-object json envelope is returned verbatim', () => {
    assert.deepEqual(parseResultEnvelope(JSON.stringify(RESULT)), RESULT);
  });

  test('a single-object envelope without an explicit type is still recovered', () => {
    const env = { is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    assert.deepEqual(parseResultEnvelope(JSON.stringify(env)), env);
  });

  test('stream-json JSONL returns the terminal result event', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'considering' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__review_collector__request_change' }] } }),
      JSON.stringify(RESULT),
    ].join('\n') + '\n';
    assert.deepEqual(parseResultEnvelope(stream), RESULT);
  });

  test('assertSucceeded and extractUsage work off a stream-json transcript', () => {
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
      JSON.stringify(RESULT),
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stream));
    const usage = extractUsage(stream, { ...BASE_CONFIG, endpoint: { ...BASE_CONFIG.endpoint, baseUrl: 'https://api.deepseek.com/anthropic' }, model: 'deepseek-v4-pro' });
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 10);
  });

  test('a multi-line stream with no terminal result is a failure (assertSucceeded throws)', () => {
    // A genuine stream-json transcript that never reached a result event: the whole-stdout parse
    // fails (multi-line) and no `type:"result"` line exists, so the envelope is unrecoverable.
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ].join('\n');
    assert.throws(() => assertSucceeded(stream), /invalid JSON/);
  });
});
