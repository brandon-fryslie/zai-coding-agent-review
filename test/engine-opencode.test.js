'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  opencodeAdapter,
  OPENCODE_TIMEOUT_MS,
  MCP_SERVER_NAME,
  buildOpencodeConfig,
  buildCommand,
  assertSucceeded,
  classifyError,
  extractUsage,
} = require('../src/engine/opencode');
const { TransientError } = require('../src/failover');
const { totalInputTokens } = require('../src/usage');

// Minimal config matching the ReviewConfig shape used by opencode configs. The model carries the
// `<provider>/<model>` prefix OpenCode uses to resolve the provider whose endpoint we override.
const BASE_CONFIG = {
  name: 'oc-mini',
  engine: 'opencode',
  model: 'openai/gpt-5.4-mini',
  endpoint: { apiType: 'openai-chat', baseUrl: 'https://api.openai.com/v1', credential: { kind: 'api-key', value: 'sk-test-key-xyz' },
  },
};

// Mirrors what createReviewCollector writes to mcpConfigPath: node binary + dist entry + arg.
const MOCK_COLLECTOR_SPAWN = {
  command: '/usr/bin/node',
  args: ['/path/to/dist/index.js', '--review-collector-server'],
  env: { REVIEW_COLLECTOR_RECORDS: '/tmp/records.jsonl' },
};

const MOCK_AGENTS_PATH = '/tmp/test-home/opencode/AGENTS.md';
const MOCK_HOME = '/tmp/test-opencode-home';

// --- buildOpencodeConfig ---

describe('buildOpencodeConfig — generated opencode.json content', () => {
  const cfg = () => buildOpencodeConfig(BASE_CONFIG, MOCK_COLLECTOR_SPAWN, MOCK_AGENTS_PATH);

  test('model is the full provider/model string', () => {
    assert.equal(cfg().model, 'openai/gpt-5.4-mini');
  });

  test('provider block is keyed by the model prefix and overrides baseURL + apiKey', () => {
    const provider = cfg().provider;
    assert.deepEqual(Object.keys(provider), ['openai']);
    assert.equal(provider.openai.options.baseURL, 'https://api.openai.com/v1');
    assert.equal(provider.openai.options.apiKey, 'sk-test-key-xyz');
  });

  test('permission block denies every mutating capability', () => {
    const perm = cfg().permission;
    assert.equal(perm.edit, 'deny');
    assert.equal(perm.bash, 'deny');
    assert.equal(perm.webfetch, 'deny');
    assert.equal(perm.websearch, 'deny');
  });

  test('permission block allows the read-side tools', () => {
    const perm = cfg().permission;
    assert.equal(perm.read, 'allow');
    assert.equal(perm.grep, 'allow');
    assert.equal(perm.glob, 'allow');
    assert.equal(perm.list, 'allow');
  });

  test('instructions reference the AGENTS.md by absolute path', () => {
    assert.deepEqual(cfg().instructions, [MOCK_AGENTS_PATH]);
  });

  test('mcp block registers the collector as a local server', () => {
    const mcp = cfg().mcp.review_collector;
    assert.equal(mcp.type, 'local');
    assert.equal(mcp.enabled, true);
  });

  test('mcp command is the collector spawn argv (node + dist entry + arg)', () => {
    const mcp = cfg().mcp.review_collector;
    assert.deepEqual(mcp.command, ['/usr/bin/node', '/path/to/dist/index.js', '--review-collector-server']);
  });

  test('mcp environment carries REVIEW_COLLECTOR_RECORDS', () => {
    const mcp = cfg().mcp.review_collector;
    assert.equal(mcp.environment.REVIEW_COLLECTOR_RECORDS, '/tmp/records.jsonl');
  });

  test('credential is written into the config, never referenced as {env:VAR}', () => {
    // The spawned process gets no secret in its env; the key lives in the (temp, isolated) config.
    const json = JSON.stringify(cfg());
    assert.ok(json.includes('sk-test-key-xyz'), 'apiKey value should be embedded');
    assert.equal(json.includes('{env:'), false, 'no {env:...} indirection — process env stays secret-free');
  });

  test('provider id tracks the model prefix for a non-openai provider', () => {
    const config = { ...BASE_CONFIG, model: 'anthropic/claude-x', endpoint: { ...BASE_CONFIG.endpoint, apiType: 'anthropic-messages' } };
    const provider = buildOpencodeConfig(config, MOCK_COLLECTOR_SPAWN, MOCK_AGENTS_PATH).provider;
    assert.deepEqual(Object.keys(provider), ['anthropic']);
  });
});

// --- buildCommand ---

describe('buildCommand', () => {
  test('command is "npx"', () => {
    assert.equal(buildCommand({ home: MOCK_HOME }).command, 'npx');
  });

  test('args invoke opencode run --format json', () => {
    const { args } = buildCommand({ home: MOCK_HOME });
    assert.ok(args.some(a => a.includes('opencode-ai')), 'opencode package not in args');
    assert.ok(args.includes('run'), 'run subcommand missing');
    assert.ok(args.includes('--format'), '--format flag missing');
    assert.ok(args.includes('json'), 'json format value missing');
  });

  test('no message positional is appended — the prompt is delivered on stdin', () => {
    const { args } = buildCommand({ home: MOCK_HOME });
    assert.equal(args[args.length - 1], 'json', 'last arg must be the format value, not a message');
  });

  test('XDG_CONFIG_HOME and XDG_DATA_HOME point at the isolated config home', () => {
    const { env } = buildCommand({ home: '/custom/home' });
    assert.equal(env.XDG_CONFIG_HOME, '/custom/home');
    assert.equal(env.XDG_DATA_HOME, '/custom/home');
  });

  test('OPENCODE_DISABLE_PROJECT_CONFIG isolates the reviewer from the reviewed repo cwd', () => {
    // The review runs with cwd = the reviewed repo; without this flag a malicious PR's own
    // ./opencode.json would merge into and take over the reviewer subprocess.
    const { env } = buildCommand({ home: MOCK_HOME });
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  });

  test('PATH and HOME are passed through', () => {
    const { env } = buildCommand({ home: MOCK_HOME });
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
  });

  test('the credential is NOT injected via env — it lives in the config home', () => {
    const { env } = buildCommand({ home: MOCK_HOME });
    assert.equal(env.OPENAI_API_KEY, undefined);
  });

  test('env is an explicit allowlist — does not leak arbitrary process.env vars', () => {
    // Spreading process.env would expose GITHUB_TOKEN and repo secrets to the AI subprocess.
    const { env } = buildCommand({ home: MOCK_HOME });
    const allowedKeys = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OPENCODE_DISABLE_PROJECT_CONFIG']);
    for (const key of Object.keys(env)) {
      assert.ok(allowedKeys.has(key), `unexpected env var leaked into subprocess: ${key}`);
    }
  });
});

// --- assertSucceeded ---

describe('assertSucceeded', () => {
  test('does not throw when a step_finish with reason "stop" is present', () => {
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"done"}}',
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"input":100,"output":10}}}',
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stdout));
  });

  test('does not throw across multiple steps when the terminal step is "stop"', () => {
    const stdout = [
      '{"type":"step_finish","part":{"reason":"tool-calls","tokens":{"input":50,"output":5}}}',
      '{"type":"step_finish","part":{"reason":"stop","tokens":{"input":60,"output":8}}}',
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stdout));
  });

  test('throws on empty output — no terminal event (exit 0 model-not-found / killed hang)', () => {
    assert.throws(() => assertSucceeded(''), /did not complete.*reason "stop"/);
  });

  test('throws when only intermediate tool-call steps were emitted', () => {
    const stdout = '{"type":"step_finish","part":{"reason":"tool-calls","tokens":{"input":50,"output":5}}}';
    assert.throws(() => assertSucceeded(stdout), /did not complete/);
  });

  test('non-JSON log noise is skipped', () => {
    const stdout = [
      'INFO 2026-06-14 service=session.prompt status=started',
      '{"type":"step_finish","part":{"reason":"stop","tokens":{}}}',
    ].join('\n');
    assert.doesNotThrow(() => assertSucceeded(stdout));
  });
});

// --- extractUsage ---

describe('extractUsage', () => {
  test('sums tokens across per-step step_finish events', () => {
    const stdout = [
      '{"type":"step_finish","part":{"reason":"tool-calls","cost":0,"tokens":{"input":15329,"output":300,"reasoning":234,"cache":{"read":0,"write":0}}}}',
      '{"type":"step_finish","part":{"reason":"stop","cost":0,"tokens":{"input":578,"output":414,"reasoning":355,"cache":{"read":14848,"write":0}}}}',
    ].join('\n');
    const usage = extractUsage(stdout);
    // input = 15329 + 0 + 0 + 578 + 14848 + 0 = 30755 ; output = 300 + 234 + 414 + 355 = 1303
    assert.equal(totalInputTokens(usage.tokens), 30755);
    assert.equal(usage.tokens.output, 1303);
    // …and the input total is split into THE TOKEN RECORD's disjoint classes: cache reads are the
    // discounted class, fresh input + cache writes the full-rate one. 15329 + 578 miss, 14848 hit.
    assert.deepEqual(usage.tokens, { inputCacheMiss: 15907, inputCacheHit: 14848, output: 1303 });
  });

  test('cost is the summed self-reported USD on a dollars basis', () => {
    const stdout = [
      '{"type":"step_finish","part":{"reason":"tool-calls","cost":0.012,"tokens":{"input":100,"output":10}}}',
      '{"type":"step_finish","part":{"reason":"stop","cost":0.004,"tokens":{"input":20,"output":5}}}',
    ].join('\n');
    const usage = extractUsage(stdout);
    assert.equal(usage.cost.basis, 'dollars');
    assert.ok(Math.abs(usage.cost.usd - 0.016) < 1e-9, `expected ~0.016, got ${usage.cost.usd}`);
  });

  test('a provider OpenCode does not price reports a real dollars-basis usd 0 (engine self-report)', () => {
    const stdout = '{"type":"step_finish","part":{"reason":"stop","cost":0,"tokens":{"input":100,"output":10}}}';
    const usage = extractUsage(stdout);
    assert.equal(usage.cost.basis, 'dollars');
    assert.equal(usage.cost.usd, 0);
  });

  test('reports cost unpriced (not a fabricated $0.00) when tokens are present but no cost field was ever observed', () => {
    const stdout = [
      '{"type":"step_finish","part":{"reason":"tool-calls","tokens":{"input":100,"output":10}}}',
      '{"type":"step_finish","part":{"reason":"stop","tokens":{"input":20,"output":5}}}',
    ].join('\n');
    const usage = extractUsage(stdout);
    assert.equal(totalInputTokens(usage.tokens), 120);
    assert.equal(usage.tokens.output, 15);
    assert.equal(usage.cost.basis, 'unpriced');
    assert.equal(usage.cost.reason, 'not-reported');
  });

  test('returns null when no usage was reported at all', () => {
    const stdout = '{"type":"text","part":{"type":"text","text":"hi"}}';
    assert.equal(extractUsage(stdout), null);
  });
});

// --- classifyError ---

describe('classifyError', () => {
  const base = new Error('spawn failed');

  test('429 text produces a rate-limited TransientError', () => {
    const result = classifyError(base, 'HTTP 429 Too Many Requests');
    assert.ok(result instanceof TransientError);
    assert.ok(result.message.includes('rate-limited'));
  });

  test('overloaded / 529 text produces a TransientError', () => {
    assert.ok(classifyError(base, '529 overloaded') instanceof TransientError);
    assert.ok(classifyError(base, 'server overloaded') instanceof TransientError);
  });

  // The shared transient vocabulary (classifyTransient in src/failover.js) is now recognized by every
  // engine identically — opencode previously lacked the network class, so a dropped socket that escaped
  // its internal retries fell through as fatal while claude-code retried it. These assert the shared class.
  test('shared network class is recognized identically (dropped socket / 5xx / socket codes)', () => {
    assert.ok(classifyError(base, 'API Error: terminated') instanceof TransientError);
    assert.ok(classifyError(base, 'API Error: 502 Bad Gateway') instanceof TransientError);
    assert.ok(classifyError(base, 'getaddrinfo ENOTFOUND api.example.com') instanceof TransientError);
  });

  test('bare English phrases do NOT false-match without the API-error anchor', () => {
    assert.equal(classifyError(base, 'we log when fetch failed in the client'), base);
    assert.equal(classifyError(base, 'the worker process at line 502 was cleanly shut down'), base);
  });

  test('unrelated error is returned unchanged', () => {
    assert.equal(classifyError(base, 'unexpected token at line 5'), base);
  });
});

// --- adapter interface declarations ---

describe('opencodeAdapter interface declarations', () => {
  test('name is "opencode"', () => {
    assert.equal(opencodeAdapter.name, 'opencode');
  });

  test('OPENCODE_TIMEOUT_MS is 3000000', () => {
    assert.equal(OPENCODE_TIMEOUT_MS, 3_000_000);
  });

  test('reasoningEfforts is the empty set (no reasoning-effort control)', () => {
    assert.deepEqual(opencodeAdapter.capabilities.reasoningEfforts, []);
  });

  test('apiTypes are the provider protocols opencode can front', () => {
    assert.deepEqual(
      opencodeAdapter.capabilities.apiTypes,
      ['openai-chat', 'openai-responses', 'anthropic-messages'],
    );
  });

  test('toolNames use the opencode <server>_<tool> convention (verified via live handshake)', () => {
    assert.equal(opencodeAdapter.toolNames.requestChange, 'review_collector_request_change');
    assert.equal(opencodeAdapter.toolNames.finishReview, 'review_collector_finish_review');
    // Guard against the codex/claude-code mcp__ prefix sneaking back in.
    assert.equal(opencodeAdapter.toolNames.requestChange.startsWith('mcp__'), false);
  });

  test('toolNames are derived from MCP_SERVER_NAME', () => {
    assert.equal(opencodeAdapter.toolNames.requestChange, `${MCP_SERVER_NAME}_request_change`);
    assert.equal(opencodeAdapter.toolNames.finishReview, `${MCP_SERVER_NAME}_finish_review`);
  });

  // [LAW:behavior-not-structure] The lifted seam: the public adapter exposes produceReview, not the
  // subprocess primitives, which are CLI-internal and tested directly as exported functions above.
  test('adapter exposes the lifted produceReview interface, not subprocess primitives', () => {
    assert.equal(typeof opencodeAdapter.produceReview, 'function');
    assert.equal(opencodeAdapter.materializeHome, undefined);
    assert.equal(opencodeAdapter.buildCommand, undefined);
  });
});

// --- registry integration ---

describe('registry includes opencode adapter', () => {
  test('registry.get("opencode") returns the opencode adapter', () => {
    const registry = require('../src/engine/registry');
    assert.equal(registry.get('opencode').name, 'opencode');
  });
});

// --- config-load AC: reasoning rejected against the REAL adapter ---

describe('config validation rejects reasoning on a real opencode config (T8 AC)', () => {
  test('reasoning on an opencode config fails at load, citing the capability', () => {
    const { validateFile } = require('../src/config');
    const realRegistry = require('../src/engine/registry');
    const raw = {
      version: 1,
      default: 'oc',
      configs: {
        oc: {
          engine: 'opencode',
          model: 'openai/gpt-5.4-mini',
          reasoning: 'high',
          endpoint: { apiType: 'openai-chat', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY' },
        },
      },
    };
    assert.throws(
      () => validateFile(raw, realRegistry),
      err => {
        assert.ok(/reasoning.*high/.test(err.message), `missing reasoning value in: ${err.message}`);
        assert.ok(/engine declares no reasoning efforts/.test(err.message), `missing capability explanation in: ${err.message}`);
        return true;
      },
    );
  });
});
