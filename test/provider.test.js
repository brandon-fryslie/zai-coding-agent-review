'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { synthesizeProviderConfig, PROVIDER_NAMES } = require('../src/provider');

// [LAW:verifiable-goals] AC: in simple mode the PROVIDER value alone selects the engine;
// credential presence never steers it; the selected provider's missing key fails loud;
// model/baseUrl/reasoning overrides are honored and validated against adapter capabilities.

// Stub registry so reasoning validation does not depend on the real adapters.
const MOCK_REGISTRY = {
  get(name) {
    const adapters = {
      codex: { capabilities: { reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] } },
      'claude-code': { capabilities: { reasoningEfforts: ['low', 'medium', 'high', 'max'] } },
    };
    return adapters[name];
  },
};

describe('synthesizeProviderConfig — defaults', () => {
  test('codex provider with only a key uses the canonical endpoint and default model', () => {
    const config = synthesizeProviderConfig({ provider: 'codex', openaiApiKey: 'sk-openai' }, MOCK_REGISTRY);
    assert.equal(config.engine, 'codex');
    assert.equal(config.model, 'gpt-5.4-mini');
    assert.equal(config.endpoint.kind, 'openai-responses');
    assert.deepEqual(config.endpoint.auth, {
      method: 'api-key', baseUrl: 'https://api.openai.com/v1', credential: 'sk-openai',
    });
    assert.equal(config.reasoning, undefined);
  });

  test('zai provider with only a key uses the z.ai endpoint and default model', () => {
    const config = synthesizeProviderConfig({ provider: 'zai', zaiApiKey: 'zai-key' }, MOCK_REGISTRY);
    assert.equal(config.engine, 'claude-code');
    assert.equal(config.model, 'glm-5.1');
    assert.equal(config.endpoint.kind, 'anthropic-messages');
    assert.deepEqual(config.endpoint.auth, {
      method: 'api-key', baseUrl: 'https://api.z.ai/api/anthropic', credential: 'zai-key',
    });
  });
});

describe('synthesizeProviderConfig — provider is chosen only by PROVIDER, never by key presence', () => {
  test('provider=codex with a z.ai key but no OpenAI key fails for OPENAI_API_KEY (key presence does not switch provider)', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'codex', zaiApiKey: 'zai-key' }, MOCK_REGISTRY),
      err => {
        assert.ok(/OPENAI_API_KEY/.test(err.message), `expected OPENAI_API_KEY in: ${err.message}`);
        assert.ok(!/glm|z\.ai/i.test(err.message));
        return true;
      },
    );
  });

  test('provider=zai with an OpenAI key but no z.ai key fails for ZAI_API_KEY', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'zai', openaiApiKey: 'sk-openai' }, MOCK_REGISTRY),
      err => {
        assert.ok(/ZAI_API_KEY/.test(err.message), `expected ZAI_API_KEY in: ${err.message}`);
        return true;
      },
    );
  });

  test('both keys present, provider=codex → codex engine (z.ai key ignored)', () => {
    const config = synthesizeProviderConfig(
      { provider: 'codex', openaiApiKey: 'sk-openai', zaiApiKey: 'zai-key' },
      MOCK_REGISTRY,
    );
    assert.equal(config.engine, 'codex');
    assert.equal(config.endpoint.auth.credential, 'sk-openai');
  });
});

describe('synthesizeProviderConfig — overrides', () => {
  test('explicit model overrides the provider default', () => {
    const config = synthesizeProviderConfig({ provider: 'codex', openaiApiKey: 'k', openaiModel: 'gpt-5.5' }, MOCK_REGISTRY);
    assert.equal(config.model, 'gpt-5.5');
  });

  test('explicit baseUrl overrides the canonical endpoint', () => {
    const config = synthesizeProviderConfig(
      { provider: 'codex', openaiApiKey: 'k', openaiBaseUrl: 'https://gateway.example/v1' },
      MOCK_REGISTRY,
    );
    assert.equal(config.endpoint.auth.baseUrl, 'https://gateway.example/v1');
  });

  test('valid reasoning effort passes through', () => {
    const config = synthesizeProviderConfig({ provider: 'codex', openaiApiKey: 'k', openaiReasoning: 'high' }, MOCK_REGISTRY);
    assert.equal(config.reasoning, 'high');
  });

  test('invalid reasoning effort fails loud naming allowed values', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'codex', openaiApiKey: 'k', openaiReasoning: 'ultra' }, MOCK_REGISTRY),
      err => {
        assert.ok(/reasoning 'ultra' is not valid/.test(err.message), err.message);
        assert.ok(/minimal, low, medium, high, xhigh/.test(err.message));
        return true;
      },
    );
  });

  test('zai system prompt is carried onto the config', () => {
    const config = synthesizeProviderConfig({ provider: 'zai', zaiApiKey: 'k', zaiSystemPrompt: 'Be strict.' }, MOCK_REGISTRY);
    assert.equal(config.systemPrompt, 'Be strict.');
  });
});

describe('synthesizeProviderConfig — deepseek provider', () => {
  test('deepseek with only a key uses the DeepSeek Anthropic endpoint and default model on the claude-code engine', () => {
    const config = synthesizeProviderConfig({ provider: 'deepseek', deepseekApiKey: 'sk-deepseek' }, MOCK_REGISTRY);
    assert.equal(config.engine, 'claude-code');
    assert.equal(config.model, 'deepseek-v4-pro');
    assert.equal(config.endpoint.kind, 'anthropic-messages');
    assert.deepEqual(config.endpoint.auth, {
      method: 'api-key', baseUrl: 'https://api.deepseek.com/anthropic', credential: 'sk-deepseek',
    });
    assert.equal(config.name, 'deepseek-default');
  });

  test('missing DEEPSEEK_API_KEY fails loud naming the input', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'deepseek', openaiApiKey: 'sk-openai' }, MOCK_REGISTRY),
      err => {
        assert.ok(/DEEPSEEK_API_KEY/.test(err.message), err.message);
        return true;
      },
    );
  });

  test('explicit deepseek model and baseUrl override the defaults', () => {
    const config = synthesizeProviderConfig(
      { provider: 'deepseek', deepseekApiKey: 'k', deepseekModel: 'deepseek-v4-flash', deepseekBaseUrl: 'https://gw.example/anthropic' },
      MOCK_REGISTRY,
    );
    assert.equal(config.model, 'deepseek-v4-flash');
    assert.equal(config.endpoint.auth.baseUrl, 'https://gw.example/anthropic');
  });
});

describe("synthesizeProviderConfig — 'auto' alias", () => {
  test('auto resolves to claude-subscription and runs identically, with the resolution shown in the config name', () => {
    const viaAuto = synthesizeProviderConfig({ provider: 'auto', claudeCodeOauthToken: 'k' }, MOCK_REGISTRY);
    const viaSub = synthesizeProviderConfig({ provider: 'claude-subscription', claudeCodeOauthToken: 'k' }, MOCK_REGISTRY);
    assert.equal(viaAuto.engine, viaSub.engine);
    assert.equal(viaAuto.model, viaSub.model);
    assert.deepEqual(viaAuto.endpoint, viaSub.endpoint);
    assert.equal(viaAuto.name, 'auto→claude-subscription');
  });

  // [LAW:no-silent-failure] The property that makes retargeting every 'auto' consumer from one line
  // safe: a repo still supplying only the OLD target's credential stops with a message naming the new
  // input, before any engine spawns. It must never quietly fall back to the paid provider whose key
  // happens to be present — that would spend real money on a run the operator thinks is free.
  test('auto with only the old DeepSeek key fails naming the resolution and the input to set', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'auto', deepseekApiKey: 'sk-deepseek' }, MOCK_REGISTRY),
      err => {
        assert.ok(/CLAUDE_CODE_OAUTH_TOKEN/.test(err.message), err.message);
        assert.ok(/auto.*claude-subscription/.test(err.message), `expected auto→claude-subscription in: ${err.message}`);
        return true;
      },
    );
  });

  test('naming deepseek explicitly still works — the retarget only moves the default', () => {
    const config = synthesizeProviderConfig({ provider: 'deepseek', deepseekApiKey: 'sk-deepseek' }, MOCK_REGISTRY);
    assert.equal(config.name, 'deepseek-default');
    assert.equal(config.endpoint.auth.credential, 'sk-deepseek');
  });

  test("'auto', 'deepseek' and 'claude-subscription' are all listed among valid PROVIDER values", () => {
    assert.ok(PROVIDER_NAMES.includes('auto'));
    assert.ok(PROVIDER_NAMES.includes('deepseek'));
    assert.ok(PROVIDER_NAMES.includes('claude-subscription'));
  });
});

describe('synthesizeProviderConfig — unknown provider', () => {
  test('throws naming the invalid value and the valid providers', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'gemini', openaiApiKey: 'k' }, MOCK_REGISTRY),
      err => {
        assert.ok(/Unknown PROVIDER "gemini"/.test(err.message), err.message);
        assert.ok(new RegExp(PROVIDER_NAMES.join(', ')).test(err.message));
        return true;
      },
    );
  });

  test('empty provider also fails as unknown', () => {
    assert.throws(() => synthesizeProviderConfig({ provider: '', openaiApiKey: 'k' }, MOCK_REGISTRY));
  });
});

// [LAW:verifiable-goals] AC for zai-billing-xl0.1: the subscription provider synthesizes an endpoint
// with no base URL anywhere in it, on the same claude-code engine the paid providers use.
describe('synthesizeProviderConfig — claude-subscription provider', () => {
  test('an OAuth token alone yields a subscription endpoint carrying NO baseUrl', () => {
    const config = synthesizeProviderConfig(
      { provider: 'claude-subscription', claudeCodeOauthToken: 'sk-ant-oat01-live' },
      MOCK_REGISTRY,
    );
    assert.equal(config.engine, 'claude-code');
    assert.equal(config.model, 'claude-sonnet-5');
    assert.equal(config.name, 'claude-subscription-default');
    assert.equal(config.endpoint.kind, 'anthropic-messages');
    assert.deepEqual(config.endpoint.auth, { method: 'subscription', credential: 'sk-ant-oat01-live' });
  });

  test('an explicit CLAUDE_MODEL overrides the default', () => {
    const config = synthesizeProviderConfig(
      { provider: 'claude-subscription', claudeCodeOauthToken: 'k', claudeModel: 'claude-opus-5' },
      MOCK_REGISTRY,
    );
    assert.equal(config.model, 'claude-opus-5');
  });

  test('a missing token fails loud naming CLAUDE_CODE_OAUTH_TOKEN', () => {
    assert.throws(
      () => synthesizeProviderConfig({ provider: 'claude-subscription', deepseekApiKey: 'sk-ds' }, MOCK_REGISTRY),
      err => {
        assert.ok(/CLAUDE_CODE_OAUTH_TOKEN/.test(err.message), err.message);
        return true;
      },
    );
  });

  test('PROVIDER: auto resolves here — an unconfigured consumer gets the subscription', () => {
    const viaAuto = synthesizeProviderConfig({ provider: 'auto', claudeCodeOauthToken: 'k' }, MOCK_REGISTRY);
    assert.equal(viaAuto.endpoint.auth.method, 'subscription');
    assert.equal(viaAuto.name, 'auto→claude-subscription');
  });
});

// [LAW:single-enforcer] The provider table and the adapter capability declarations are two
// representations of one fact — what a given engine can be pointed at. Nothing in the RUNTIME
// re-checks the static table, so this is the check: a row naming an endpoint kind or auth method its
// engine does not declare would fail only at spawn time, on a real PR, having already paid for the
// prompt. [FRAMING:representation]
describe('PROVIDERS rows agree with the real adapter capabilities', () => {
  const realRegistry = require('../src/engine/registry');
  const { PROVIDERS, AUTH_FROM_INPUTS } = require('../src/provider');

  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`'${name}': engine '${spec.engine}' declares its endpointKind and authMethod`, () => {
      const caps = realRegistry.get(spec.engine).capabilities;
      assert.ok(
        caps.endpointKinds.includes(spec.endpointKind),
        `endpointKind '${spec.endpointKind}' not in [${caps.endpointKinds.join(', ')}]`,
      );
      assert.ok(
        caps.authMethods.includes(spec.authMethod),
        `authMethod '${spec.authMethod}' not in [${caps.authMethods.join(', ')}]`,
      );
    });

    test(`'${name}': its auth method has a builder`, () => {
      assert.equal(typeof AUTH_FROM_INPUTS[spec.authMethod], 'function');
    });
  }
});
