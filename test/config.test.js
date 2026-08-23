'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFile, resolveChain, resolveSecrets, loadConfig, AUTH_FIELDS } = require('../src/config');

// [LAW:verifiable-goals] AC for T4: table-driven validation matrix covering every
// rejection case named in the acceptance criteria, plus happy-path chain resolution
// and env-secret loading. Every rejection message names the config, field, and allowed values.

// Stub registry injected into all pure-function tests so no real adapters are needed.
const MOCK_REGISTRY = {
  get(name) {
    const adapters = {
      'claude-code': {
        capabilities: {
          endpointKinds: ['anthropic-messages'],
          reasoningEfforts: ['low', 'medium', 'high', 'max'],
          authMethods: ['api-key', 'subscription'],
        },
      },
      codex: {
        capabilities: {
          endpointKinds: ['openai-responses'],
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          authMethods: ['api-key'],
        },
      },
      opencode: {
        capabilities: {
          endpointKinds: ['openai-chat', 'openai-responses'],
          reasoningEfforts: [],
          authMethods: ['api-key'],
        },
      },
    };
    const adapter = adapters[name];
    if (!adapter) {
      throw new Error(`Unknown engine: ${name}. Valid engines: ${Object.keys(adapters).join(', ')}`);
    }
    return adapter;
  },
};

// Minimal valid config raw object — used as a base for mutation tests
const VALID_RAW = {
  version: 1,
  default: 'zai-glm',
  fallback: ['zai-glm', 'codex-gpt55'],
  configs: {
    'zai-glm': {
      engine: 'claude-code',
      model: 'glm-5.1',
      reasoning: 'high',
      endpoint: {
        kind: 'anthropic-messages',
        auth: { method: 'api-key', baseUrl: 'https://api.z.ai/api/anthropic', credentialEnv: 'ZAI_API_KEY' },
      },
    },
    'codex-gpt55': {
      engine: 'codex',
      model: 'gpt-5.5',
      reasoning: 'xhigh',
      endpoint: {
        kind: 'openai-responses',
        auth: { method: 'api-key', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY' },
      },
    },
    'oc-mini': {
      engine: 'opencode',
      model: 'openai/gpt-4o-mini',
      endpoint: {
        kind: 'openai-chat',
        auth: { method: 'api-key', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY' },
      },
    },
  },
};

// Deep-clone helper — tests mutate copies of VALID_RAW, never the original
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─── validateFile — rejection matrix ────────────────────────────────────────

describe('validateFile — null/empty input guard', () => {
  test('null (empty YAML file) rejects with informative message', () => {
    assert.throws(
      () => validateFile(null, MOCK_REGISTRY),
      { message: /empty or is not a YAML mapping/ },
    );
  });

  test('array rejects as non-mapping', () => {
    assert.throws(
      () => validateFile([], MOCK_REGISTRY),
      { message: /empty or is not a YAML mapping/ },
    );
  });
});

describe('validateFile — version check', () => {
  test('version 1 is accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('unknown version rejects with informative message', () => {
    const raw = clone(VALID_RAW);
    raw.version = 99;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /unknown version.*99.*Supported: 1/i },
    );
  });

  test('missing version rejects', () => {
    const raw = clone(VALID_RAW);
    delete raw.version;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /unknown version/i },
    );
  });
});

describe('validateFile — engine validation', () => {
  test('unknown engine names the config and lists valid engines', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].engine = 'llama-cli';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/Unknown engine.*llama-cli/i.test(err.message), `missing engine name in: ${err.message}`);
        assert.ok(/Valid engines:/.test(err.message), `missing valid engines list in: ${err.message}`);
        return true;
      },
    );
  });
});

describe('validateFile — endpoint.kind vs adapter endpointKinds', () => {
  test('codex + anthropic-messages endpoint is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.configs['codex-gpt55'].endpoint.kind = 'anthropic-messages';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'codex-gpt55'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/endpoint\.kind.*anthropic-messages/.test(err.message), `missing kind in: ${err.message}`);
        assert.ok(/Allowed:.*openai-responses/.test(err.message), `missing allowed list in: ${err.message}`);
        return true;
      },
    );
  });

  test('opencode + openai-chat endpoint is accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('unknown endpoint.kind names the config and allowed values', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.kind = 'grpc-streaming';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message));
        assert.ok(/grpc-streaming/.test(err.message));
        assert.ok(/Allowed:/.test(err.message));
        return true;
      },
    );
  });
});

// [LAW:verifiable-goals] AC for zai-billing-xl0.1: the auth union is enforced at the config-file
// boundary — the engine's declared authMethods gate the method, and each variant takes exactly its
// own fields. "Subscription token pointed at z.ai" must be a LOAD-TIME error, not a silent drop.
describe('validateFile — endpoint.auth vs adapter authMethods', () => {
  test('claude-code + subscription auth is accepted', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.auth = { method: 'subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });

  test('codex + subscription auth is rejected — the engine has no channel for it', () => {
    const raw = clone(VALID_RAW);
    raw.configs['codex-gpt55'].endpoint.auth = { method: 'subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'codex-gpt55'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/endpoint\.auth\.method 'subscription'/.test(err.message), `missing method in: ${err.message}`);
        assert.ok(/Allowed: api-key/.test(err.message), `missing allowed list in: ${err.message}`);
        return true;
      },
    );
  });

  test('a subscription auth carrying a baseUrl is REJECTED, never silently ignored', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.auth = {
      method: 'subscription',
      credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
      baseUrl: 'https://api.z.ai/api/anthropic',
    };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/'baseUrl'/.test(err.message), `missing offending field in: ${err.message}`);
        assert.ok(/subscription/.test(err.message), `missing method in: ${err.message}`);
        return true;
      },
    );
  });

  test('an api-key auth missing baseUrl names the field and the method that requires it', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].endpoint.auth.baseUrl;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /endpoint\.auth\.baseUrl.*api-key/ },
    );
  });

  test('a missing credentialEnv is rejected for every method', () => {
    for (const auth of [
      { method: 'api-key', baseUrl: 'https://api.z.ai/api/anthropic' },
      { method: 'subscription' },
    ]) {
      const raw = clone(VALID_RAW);
      raw.configs['zai-glm'].endpoint.auth = auth;
      assert.throws(
        () => validateFile(raw, MOCK_REGISTRY),
        { message: /endpoint\.auth\.credentialEnv/ },
        `method '${auth.method}' accepted a config with no credentialEnv`,
      );
    }
  });

  test('a missing auth block names the methods the engine allows', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].endpoint.auth;
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /endpoint\.auth\.method.*Allowed for engine 'claude-code': api-key, subscription/ },
    );
  });

  test('an unknown auth method names the config and the allowed methods', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.auth = { method: 'oauth-device-flow', credentialEnv: 'X' };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /Config 'zai-glm'.*oauth-device-flow.*Allowed: api-key, subscription/ },
    );
  });
});

describe('validateFile — reasoning effort validation', () => {
  test('valid reasoning level accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('reasoning on opencode is rejected — engine declares no reasoning efforts', () => {
    const raw = clone(VALID_RAW);
    raw.configs['oc-mini'].reasoning = 'high';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'oc-mini'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/reasoning.*high/.test(err.message), `missing reasoning value in: ${err.message}`);
        assert.ok(/engine declares no reasoning efforts/.test(err.message), `missing explanation in: ${err.message}`);
        return true;
      },
    );
  });

  test('invalid reasoning level names the config and allowed values', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].reasoning = 'turbo';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message));
        assert.ok(/reasoning.*turbo/.test(err.message));
        assert.ok(/Allowed:.*low.*medium.*high.*max/.test(err.message));
        return true;
      },
    );
  });

  test('absent reasoning field is accepted (field is optional)', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].reasoning;
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });
});

describe('validateFile — default and fallback reference validation', () => {
  test('default naming a missing config is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.default = 'nonexistent';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/default.*nonexistent/.test(err.message), `missing default name in: ${err.message}`);
        assert.ok(/Defined:/.test(err.message), `missing defined list in: ${err.message}`);
        return true;
      },
    );
  });

  test('fallback entry naming a missing config is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.fallback = ['zai-glm', 'ghost-config'];
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/fallback.*ghost-config/.test(err.message), `missing fallback name in: ${err.message}`);
        assert.ok(/Defined:/.test(err.message), `missing defined list in: ${err.message}`);
        return true;
      },
    );
  });

  test('absent fallback is accepted (field is optional)', () => {
    const raw = clone(VALID_RAW);
    delete raw.fallback;
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });
});

// ─── resolveChain — ordering ─────────────────────────────────────────────────

describe('resolveChain — chain ordering', () => {
  test('default is chain[0] when no selectedName', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain[0].name, 'zai-glm');
  });

  test('selectedName overrides default as chain[0]', () => {
    const chain = resolveChain(VALID_RAW, 'codex-gpt55');
    assert.equal(chain[0].name, 'codex-gpt55');
  });

  test('fallback minus selected follows in order', () => {
    // fallback: ['zai-glm', 'codex-gpt55']; default: 'zai-glm' → chain = [zai-glm, codex-gpt55]
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, 'zai-glm');
    assert.equal(chain[1].name, 'codex-gpt55');
  });

  test('selected config is deduped from fallback', () => {
    // selecting 'codex-gpt55' which is in fallback → chain = [codex-gpt55, zai-glm]
    const chain = resolveChain(VALID_RAW, 'codex-gpt55');
    assert.equal(chain.length, 2);
    assert.equal(chain[0].name, 'codex-gpt55');
    assert.equal(chain[1].name, 'zai-glm');
  });

  test('no fallback produces single-entry chain', () => {
    const raw = { ...VALID_RAW, fallback: undefined };
    const chain = resolveChain(raw, null);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].name, 'zai-glm');
  });

  test('chain entries carry model, engine, endpoint.kind, and the whole auth variant', () => {
    const chain = resolveChain(VALID_RAW, null);
    const entry = chain[0];
    assert.equal(entry.engine, 'claude-code');
    assert.equal(entry.model, 'glm-5.1');
    assert.equal(entry.endpoint.kind, 'anthropic-messages');
    assert.deepEqual(entry.endpoint.auth, {
      method: 'api-key',
      baseUrl: 'https://api.z.ai/api/anthropic',
      credentialEnv: 'ZAI_API_KEY',
    });
  });

  test('a subscription entry resolves to the variant with NO baseUrl key at all', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.auth = { method: 'subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    const entry = resolveChain(raw, null)[0];
    assert.deepEqual(entry.endpoint.auth, { method: 'subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' });
    assert.ok(!('baseUrl' in entry.endpoint.auth), 'subscription auth must carry no baseUrl');
  });

  test('reasoning is preserved when set', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.equal(chain[0].reasoning, 'high');
  });

  test('reasoning is absent when not in config', () => {
    const raw = clone(VALID_RAW);
    delete raw.configs['zai-glm'].reasoning;
    const chain = resolveChain(raw, null);
    assert.ok(!('reasoning' in chain[0]));
  });

  test('reasoning: null (bare YAML key) is treated as absent — not copied to chain', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].reasoning = null;
    const chain = resolveChain(raw, null);
    assert.ok(!('reasoning' in chain[0]), 'reasoning: null should not appear in chain entry');
  });
});

// ─── resolveSecrets — env-secret population ──────────────────────────────────

describe('resolveSecrets — env resolution', () => {
  test('credential is populated from env[credentialEnv]', () => {
    const chain = resolveChain(VALID_RAW, null);
    const resolved = resolveSecrets(chain, { ZAI_API_KEY: 'sk-test-123', OPENAI_API_KEY: 'sk-oai-456' });
    assert.equal(resolved[0].endpoint.auth.credential, 'sk-test-123');
    assert.equal(resolved[1].endpoint.auth.credential, 'sk-oai-456');
  });

  test('credentialEnv is removed from the resolved auth', () => {
    const chain = resolveChain(VALID_RAW, null);
    const resolved = resolveSecrets(chain, { ZAI_API_KEY: 'k', OPENAI_API_KEY: 'k2' });
    assert.ok(!('credentialEnv' in resolved[0].endpoint.auth));
  });

  // [LAW:one-type-per-behavior] One swap serves every variant — the subscription token resolves by
  // the same path as an API key, with no second branch that a new variant could miss.
  test('a subscription token resolves through the same one swap, keeping the variant intact', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.auth = { method: 'subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    const chain = resolveChain(raw, null);
    const resolved = resolveSecrets(chain, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-live', OPENAI_API_KEY: 'k2' });
    assert.deepEqual(resolved[0].endpoint.auth, { method: 'subscription', credential: 'sk-ant-oat-live' });
  });

  test('missing env var rejects with config name and var name', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.throws(
      () => resolveSecrets(chain, {}),
      err => {
        assert.ok(/Config 'zai-glm'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/ZAI_API_KEY/.test(err.message), `missing var name in: ${err.message}`);
        return true;
      },
    );
  });

  test('empty string env var rejects (not set or empty)', () => {
    const chain = resolveChain(VALID_RAW, null);
    assert.throws(
      () => resolveSecrets(chain, { ZAI_API_KEY: '' }),
      { message: /ZAI_API_KEY.*not set or empty/ },
    );
  });
});

// ─── loadConfig — end-to-end with real file I/O ──────────────────────────────

describe('loadConfig — file loading', () => {
  function writeTempConfig(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-config-test-'));
    const filePath = path.join(dir, 'review-agents.yml');
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true }) };
  }

  test('valid YAML file loads and resolves chain', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      auth:
        method: api-key
        baseUrl: https://api.z.ai/api/anthropic
        credentialEnv: MY_API_KEY
`);
    try {
      const chain = loadConfig(filePath, null, { MY_API_KEY: 'sk-live-xyz' }, MOCK_REGISTRY);
      assert.equal(chain.length, 1);
      assert.equal(chain[0].name, 'zai-glm');
      assert.equal(chain[0].endpoint.auth.credential, 'sk-live-xyz');
      assert.ok(!('credentialEnv' in chain[0].endpoint.auth));
    } finally {
      cleanup();
    }
  });

  test('selected config overrides default', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      auth:
        method: api-key
        baseUrl: https://api.z.ai/api/anthropic
        credentialEnv: ZAI_KEY
  codex-gpt55:
    engine: codex
    model: gpt-5.5
    endpoint:
      kind: openai-responses
      auth:
        method: api-key
        baseUrl: https://api.openai.com/v1
        credentialEnv: OAI_KEY
`);
    try {
      const chain = loadConfig(filePath, 'codex-gpt55', { ZAI_KEY: 'a', OAI_KEY: 'b' }, MOCK_REGISTRY);
      assert.equal(chain[0].name, 'codex-gpt55');
      assert.equal(chain[0].endpoint.auth.credential, 'b');
    } finally {
      cleanup();
    }
  });

  test('unknown selectedName rejects with informative message', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: zai-glm
configs:
  zai-glm:
    engine: claude-code
    model: glm-5.1
    endpoint:
      kind: anthropic-messages
      auth:
        method: api-key
        baseUrl: https://api.z.ai/api/anthropic
        credentialEnv: MY_KEY
`);
    try {
      assert.throws(
        () => loadConfig(filePath, 'ghost', { MY_KEY: 'k' }, MOCK_REGISTRY),
        err => {
          assert.ok(/ghost/.test(err.message));
          assert.ok(/not found/.test(err.message));
          assert.ok(/zai-glm/.test(err.message));
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  test('a subscription config loads end to end from YAML', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: claude-sub
configs:
  claude-sub:
    engine: claude-code
    model: claude-sonnet-5
    endpoint:
      kind: anthropic-messages
      auth:
        method: subscription
        credentialEnv: CLAUDE_CODE_OAUTH_TOKEN
`);
    try {
      const chain = loadConfig(filePath, null, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-live' }, MOCK_REGISTRY);
      assert.deepEqual(chain[0].endpoint.auth, { method: 'subscription', credential: 'sk-ant-oat01-live' });
    } finally {
      cleanup();
    }
  });

  test('a subscription config with a baseUrl is refused at load, not silently stripped', () => {
    const { filePath, cleanup } = writeTempConfig(`
version: 1
default: claude-sub
configs:
  claude-sub:
    engine: claude-code
    model: claude-sonnet-5
    endpoint:
      kind: anthropic-messages
      auth:
        method: subscription
        credentialEnv: CLAUDE_CODE_OAUTH_TOKEN
        baseUrl: https://api.z.ai/api/anthropic
`);
    try {
      assert.throws(
        () => loadConfig(filePath, null, { CLAUDE_CODE_OAUTH_TOKEN: 'k' }, MOCK_REGISTRY),
        { message: /'baseUrl'.*subscription/ },
      );
    } finally {
      cleanup();
    }
  });

  test('missing file rejects with informative message', () => {
    assert.throws(
      () => loadConfig('/nonexistent/review-agents.yml', null, {}, MOCK_REGISTRY),
      { message: /Failed to read config file/ },
    );
  });
});

// [LAW:single-enforcer] Every auth method an adapter ADVERTISES must be a variant this module knows
// how to parse and resolve. Without this, an adapter could declare a method whose fields AUTH_FIELDS
// has no entry for, and validateFile would crash on a config file instead of rejecting it. The two
// tables are one contract enumerated twice; this is what keeps them one. [FRAMING:representation]
describe('AUTH_FIELDS covers every auth method the real adapters declare', () => {
  const realRegistry = require('../src/engine/registry');
  for (const engine of ['claude-code', 'codex', 'opencode']) {
    test(`'${engine}': every declared authMethod has an AUTH_FIELDS entry`, () => {
      const { authMethods } = realRegistry.get(engine).capabilities;
      assert.ok(Array.isArray(authMethods) && authMethods.length > 0, `${engine} declares no authMethods`);
      for (const method of authMethods) {
        assert.ok(
          Array.isArray(AUTH_FIELDS[method]),
          `engine '${engine}' declares auth method '${method}' with no AUTH_FIELDS entry`,
        );
      }
    });
  }

  // [LAW:one-type-per-behavior] The uniform credential name is what lets resolveSecrets be one swap
  // and core.setSecret one read. A variant that named its credential something else would resolve to
  // undefined and, worse, go unmasked in the Actions log.
  test('every AUTH_FIELDS variant names the credential the same way', () => {
    for (const [method, fields] of Object.entries(AUTH_FIELDS)) {
      assert.ok(
        fields.includes('credentialEnv'),
        `variant '${method}' must name its credential 'credentialEnv'`,
      );
    }
  });
});
