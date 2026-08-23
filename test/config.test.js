'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFile, resolveChain, resolveSecrets, loadConfig } = require('../src/config');

// [LAW:verifiable-goals] AC for T4: table-driven validation matrix covering every
// rejection case named in the acceptance criteria, plus happy-path chain resolution
// and env-secret loading. Every rejection message names the config, field, and allowed values.

// Stub registry injected into all pure-function tests so no real adapters are needed.
const MOCK_REGISTRY = {
  get(name) {
    const adapters = {
      'claude-code': {
        capabilities: {
          apiTypes: ['anthropic-messages'],
          reasoningEfforts: ['low', 'medium', 'high', 'max'],
          credentialKinds: ['api-key', 'oauth'],
        },
      },
      codex: {
        capabilities: {
          apiTypes: ['openai-responses'],
          reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
          credentialKinds: ['api-key'],
        },
      },
      opencode: {
        capabilities: {
          // Mirrors the real adapter, anthropic-messages included — which is what lets a test isolate
          // the CREDENTIAL-KIND gate from the apiType gate.
          apiTypes: ['openai-chat', 'openai-responses', 'anthropic-messages'],
          reasoningEfforts: [],
          credentialKinds: ['api-key'],
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
      endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', credentialEnv: 'ZAI_API_KEY',
      },
    },
    'codex-gpt55': {
      engine: 'codex',
      model: 'gpt-5.5',
      reasoning: 'xhigh',
      endpoint: { apiType: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY',
      },
    },
    'oc-mini': {
      engine: 'opencode',
      model: 'openai/gpt-4o-mini',
      endpoint: { apiType: 'openai-chat', baseUrl: 'https://api.openai.com/v1', credentialEnv: 'OPENAI_API_KEY',
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

describe('validateFile — endpoint.apiType vs adapter apiTypes', () => {
  test('codex + anthropic-messages endpoint is rejected', () => {
    const raw = clone(VALID_RAW);
    raw.configs['codex-gpt55'].endpoint.apiType = 'anthropic-messages';
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'codex-gpt55'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/endpoint\.apiType.*anthropic-messages/.test(err.message), `missing apiType in: ${err.message}`);
        assert.ok(/Allowed:.*openai-responses/.test(err.message), `missing allowed list in: ${err.message}`);
        return true;
      },
    );
  });

  test('opencode + openai-chat endpoint is accepted', () => {
    assert.doesNotThrow(() => validateFile(VALID_RAW, MOCK_REGISTRY));
  });

  test('unknown endpoint.apiType names the config and allowed values', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint.apiType = 'grpc-streaming';
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

// [LAW:verifiable-goals] THE SECURITY BOUNDARY, asserted. A config file may write one of two endpoint
// forms: a PRESET (apiType/baseUrl/credentialKind all pinned in src/provider.js — the only way to reach
// an oauth credential) or MANUAL (any apiType, any baseUrl — always api-key, because no field exists
// for it to say otherwise). The property these tests exist to pin: NO config file can pair a long-lived
// OAuth token with a host of its own choosing.
describe('validateFile — the preset / manual endpoint forms', () => {
  const presetEndpoint = () => ({ preset: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' });

  test('a preset endpoint on claude-code is accepted', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = presetEndpoint();
    assert.doesNotThrow(() => validateFile(raw, MOCK_REGISTRY));
  });

  // opencode isolates the CREDENTIAL-KIND gate: it accepts anthropic-messages, so the apiType check
  // passes and the rejection can only come from the kind. (codex would reject on apiType first and
  // never reach it — a weaker test of a different rule.)
  test('an oauth preset on an api-key-only engine is rejected for the KIND', () => {
    const raw = clone(VALID_RAW);
    raw.configs['oc-mini'].endpoint = presetEndpoint();
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      err => {
        assert.ok(/Config 'oc-mini'/.test(err.message), `missing config name in: ${err.message}`);
        assert.ok(/credential kind 'oauth'/.test(err.message), `missing kind in: ${err.message}`);
        assert.ok(/Allowed: api-key/.test(err.message), `missing allowed list in: ${err.message}`);
        return true;
      },
    );
  });

  test('an oauth preset on codex is rejected too — there on the apiType it cannot speak', () => {
    const raw = clone(VALID_RAW);
    raw.configs['codex-gpt55'].endpoint = presetEndpoint();
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /Config 'codex-gpt55'.*anthropic-messages.*not supported by engine 'codex'/ },
    );
  });

  // THE point of the whole design. There is no spelling of "oauth token at a host I chose".
  test('the manual form cannot express an oauth credential at all', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic',
      credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
      credentialKind: 'oauth', // the field a config author would reach for — it does not exist
    };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /'credentialKind'.*manual form does not take/ },
    );
  });

  test('a baseUrl beside a preset is REJECTED, never silently ignored', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = { ...presetEndpoint(), baseUrl: 'https://api.z.ai/api/anthropic' };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /'baseUrl'.*preset form does not take/ },
    );
  });

  test('an unknown preset names the config and the defined presets', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = { preset: 'not-a-preset', credentialEnv: 'X' };
    assert.throws(
      () => validateFile(raw, MOCK_REGISTRY),
      { message: /Config 'zai-glm'.*'not-a-preset' is not a known preset.*Defined:/ },
    );
  });

  test('every form requires credentialEnv', () => {
    for (const endpoint of [
      { preset: 'claude-subscription' },
      { apiType: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
    ]) {
      const raw = clone(VALID_RAW);
      raw.configs['zai-glm'].endpoint = endpoint;
      assert.throws(
        () => validateFile(raw, MOCK_REGISTRY),
        { message: /endpoint\.credentialEnv/ },
        `accepted a config with no credentialEnv: ${JSON.stringify(endpoint)}`,
      );
    }
  });

  test('the manual form still requires apiType and baseUrl', () => {
    for (const missing of ['apiType', 'baseUrl']) {
      const raw = clone(VALID_RAW);
      delete raw.configs['zai-glm'].endpoint[missing];
      assert.throws(
        () => validateFile(raw, MOCK_REGISTRY),
        new RegExp(`endpoint\\.${missing}`),
        `accepted a manual endpoint with no ${missing}`,
      );
    }
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

  test('a manual entry resolves to apiType + baseUrl + an api-key credential', () => {
    const chain = resolveChain(VALID_RAW, null);
    const entry = chain[0];
    assert.equal(entry.engine, 'claude-code');
    assert.equal(entry.model, 'glm-5.1');
    assert.deepEqual(entry.endpoint, {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic',
      credential: { kind: 'api-key', env: 'ZAI_API_KEY' },
    });
  });

  // The preset's PINNED host is what the entry gets — the config file never named a URL and had no
  // way to. This is the security property expressed as a resolved value.
  test('a preset entry resolves to the pinned host and an oauth credential', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = { preset: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    const entry = resolveChain(raw, null)[0];
    assert.deepEqual(entry.endpoint, {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      credential: { kind: 'oauth', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
    });
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
  test('the credential value is populated from env, and its env name is gone', () => {
    const chain = resolveChain(VALID_RAW, null);
    const resolved = resolveSecrets(chain, { ZAI_API_KEY: 'sk-test-123', OPENAI_API_KEY: 'sk-oai-456' });
    assert.deepEqual(resolved[0].endpoint.credential, { kind: 'api-key', value: 'sk-test-123' });
    assert.deepEqual(resolved[1].endpoint.credential, { kind: 'api-key', value: 'sk-oai-456' });
    assert.ok(!('env' in resolved[0].endpoint.credential));
  });

  // [LAW:one-type-per-behavior] ONE swap serves every credential kind — an oauth token resolves by the
  // same path as an API key, with no second branch a future kind could miss, and its `kind` rides
  // through untouched so nothing downstream re-derives how dangerous it is.
  test('an oauth credential resolves through the same one swap, keeping its kind', () => {
    const raw = clone(VALID_RAW);
    raw.configs['zai-glm'].endpoint = { preset: 'claude-subscription', credentialEnv: 'CLAUDE_CODE_OAUTH_TOKEN' };
    const chain = resolveChain(raw, null);
    const resolved = resolveSecrets(chain, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-live', OPENAI_API_KEY: 'k2' });
    assert.deepEqual(resolved[0].endpoint.credential, { kind: 'oauth', value: 'sk-ant-oat-live' });
    assert.equal(resolved[0].endpoint.baseUrl, 'https://api.anthropic.com', 'the pinned host survives resolution');
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
      apiType: anthropic-messages
      baseUrl: https://api.z.ai/api/anthropic
      credentialEnv: MY_API_KEY
`);
    try {
      const chain = loadConfig(filePath, null, { MY_API_KEY: 'sk-live-xyz' }, MOCK_REGISTRY);
      assert.equal(chain.length, 1);
      assert.equal(chain[0].name, 'zai-glm');
      assert.deepEqual(chain[0].endpoint.credential, { kind: 'api-key', value: 'sk-live-xyz' });
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
      apiType: anthropic-messages
      baseUrl: https://api.z.ai/api/anthropic
      credentialEnv: ZAI_KEY
  codex-gpt55:
    engine: codex
    model: gpt-5.5
    endpoint:
      apiType: openai-responses
      baseUrl: https://api.openai.com/v1
      credentialEnv: OAI_KEY
`);
    try {
      const chain = loadConfig(filePath, 'codex-gpt55', { ZAI_KEY: 'a', OAI_KEY: 'b' }, MOCK_REGISTRY);
      assert.equal(chain[0].name, 'codex-gpt55');
      assert.equal(chain[0].endpoint.credential.value, 'b');
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
      apiType: anthropic-messages
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
      preset: claude-subscription
      credentialEnv: CLAUDE_CODE_OAUTH_TOKEN
`);
    try {
      const chain = loadConfig(filePath, null, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-live' }, MOCK_REGISTRY);
      assert.deepEqual(chain[0].endpoint.credential, { kind: 'oauth', value: 'sk-ant-oat01-live' });
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
      preset: claude-subscription
      credentialEnv: CLAUDE_CODE_OAUTH_TOKEN
      baseUrl: https://api.z.ai/api/anthropic
`);
    try {
      assert.throws(
        () => loadConfig(filePath, null, { CLAUDE_CODE_OAUTH_TOKEN: 'k' }, MOCK_REGISTRY),
        { message: /'baseUrl'.*preset form does not take/ },
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

// [LAW:single-enforcer] THE invariant the whole security model rests on, asserted over the real table:
// an oauth credential is only ever reachable through a PINNED base URL. assertPresetsSafe enforces this
// at module load so an unsafe row cannot even be imported; this proves the enforcement itself works,
// in both directions, so deleting it from provider.js fails here rather than silently widening the
// attack surface. [FRAMING:representation]
describe('PRESETS: an oauth credential is always pinned to its host', () => {
  const { PRESETS, assertPresetsSafe } = require('../src/provider');

  test('every shipped preset declares exactly one of baseUrl (pinned) / defaultBaseUrl (overridable)', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      assert.notEqual(
        'baseUrl' in p, 'defaultBaseUrl' in p,
        `preset '${name}' must declare exactly one of baseUrl / defaultBaseUrl`,
      );
    }
  });

  test('every shipped oauth preset pins its baseUrl', () => {
    for (const [name, p] of Object.entries(PRESETS)) {
      if (p.credentialKind !== 'oauth') continue;
      assert.ok('baseUrl' in p, `oauth preset '${name}' must pin baseUrl, not offer defaultBaseUrl`);
    }
  });

  test('assertPresetsSafe REFUSES an oauth preset with an overridable base URL', () => {
    assert.throws(
      () => assertPresetsSafe({ evil: { apiType: 'anthropic-messages', defaultBaseUrl: 'https://api.evil.example', credentialKind: 'oauth' } }),
      { message: /'oauth' credential requires a PINNED 'baseUrl'/ },
    );
  });

  test('assertPresetsSafe REFUSES a preset declaring both or neither base URL field', () => {
    for (const bad of [
      { apiType: 'anthropic-messages', baseUrl: 'https://a', defaultBaseUrl: 'https://b', credentialKind: 'api-key' },
      { apiType: 'anthropic-messages', credentialKind: 'api-key' },
    ]) {
      assert.throws(
        () => assertPresetsSafe({ bad }),
        { message: /exactly one of 'baseUrl'.*or 'defaultBaseUrl'/ },
        `accepted a preset with an ambiguous base URL: ${JSON.stringify(bad)}`,
      );
    }
  });

  test('an api-key preset with an overridable base URL is fine — that is the flexible path', () => {
    assert.doesNotThrow(() => assertPresetsSafe({
      ok: { apiType: 'openai-chat', defaultBaseUrl: 'https://api.example', credentialKind: 'api-key' },
    }));
  });

  // A load-time check over a MUTABLE table proves only what the table was at import. Freezing is what
  // makes the pinned host a property of the object rather than of one past moment — otherwise any
  // later code holding the exported reference could repoint a subscription token with an assignment.
  test('the shipped table and its rows are frozen, so a pinned host cannot be repointed at runtime', () => {
    assert.ok(Object.isFrozen(PRESETS), 'PRESETS itself must be frozen');
    for (const [name, p] of Object.entries(PRESETS)) {
      assert.ok(Object.isFrozen(p), `preset row '${name}' must be frozen`);
    }
    assert.throws(
      () => { 'use strict'; PRESETS['claude-subscription'].baseUrl = 'https://evil.example'; },
      TypeError,
    );
    assert.equal(PRESETS['claude-subscription'].baseUrl, 'https://api.anthropic.com');
  });

  // resolveEndpoint reads a falsy base URL as "not set" with a single `||`. That is only sound while
  // no preset can itself declare a falsy URL — so the emptiness check lives beside the pinning rules,
  // in the one enforcer, rather than as a second guard at the resolve site. [LAW:parse-dont-validate]
  test('assertPresetsSafe REFUSES a preset whose declared base URL is empty or not a string', () => {
    for (const bad of [
      { apiType: 'anthropic-messages', baseUrl: '', credentialKind: 'oauth' },
      { apiType: 'anthropic-messages', defaultBaseUrl: '', credentialKind: 'api-key' },
      { apiType: 'anthropic-messages', defaultBaseUrl: 42, credentialKind: 'api-key' },
    ]) {
      assert.throws(
        () => assertPresetsSafe({ bad }),
        { message: /must be a non-empty string/ },
        `accepted a preset with an unusable base URL: ${JSON.stringify(bad)}`,
      );
    }
  });
});
