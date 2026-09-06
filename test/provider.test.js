'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { synthesizeProviderConfig, PROVIDER_NAMES, PROVIDERS, PRESETS, assertProvidersSafe } = require('../src/provider');

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
    assert.deepEqual(config.endpoint, {
      apiType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      credential: { kind: 'api-key', value: 'sk-openai' },
    });
    assert.equal(config.reasoning, undefined);
  });

  test('zai provider with only a key uses the z.ai endpoint and default model', () => {
    const config = synthesizeProviderConfig({ provider: 'zai', zaiApiKey: 'zai-key' }, MOCK_REGISTRY);
    assert.equal(config.engine, 'claude-code');
    assert.equal(config.model, 'glm-5.1');
    assert.deepEqual(config.endpoint, {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic',
      credential: { kind: 'api-key', value: 'zai-key' },
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
    assert.equal(config.endpoint.credential.value, 'sk-openai');
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
    assert.equal(config.endpoint.baseUrl, 'https://gateway.example/v1');
  });

  // core.getInput yields '' for an input the workflow left unset — or interpolated from an empty
  // `${{ vars.X }}`, or written blank in a copy-pasted workflow. An '' that WON the override chain
  // would spawn the engine against an empty base URL: a broken endpoint produced by a blank field.
  // Falsy therefore means "not set". [LAW:no-silent-failure]
  test('an empty baseUrl input is not an override — it falls back to the preset default', () => {
    for (const baseUrl of ['', undefined]) {
      const config = synthesizeProviderConfig(
        { provider: 'codex', openaiApiKey: 'k', openaiBaseUrl: baseUrl }, MOCK_REGISTRY,
      );
      assert.equal(config.endpoint.baseUrl, 'https://api.openai.com/v1', `baseUrl input ${JSON.stringify(baseUrl)}`);
    }
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
    assert.deepEqual(config.endpoint, {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.deepseek.com/anthropic',
      credential: { kind: 'api-key', value: 'sk-deepseek' },
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
    assert.equal(config.endpoint.baseUrl, 'https://gw.example/anthropic');
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
    assert.equal(config.endpoint.credential.value, 'sk-deepseek');
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
// whose base URL is PINNED to Anthropic's host, on the same claude-code engine the paid providers use.
describe('synthesizeProviderConfig — claude-subscription provider', () => {
  test("an OAuth token alone yields a subscription endpoint pinned to Anthropic's host", () => {
    const config = synthesizeProviderConfig(
      { provider: 'claude-subscription', claudeCodeOauthToken: 'sk-ant-oat01-live' },
      MOCK_REGISTRY,
    );
    assert.equal(config.engine, 'claude-code');
    assert.equal(config.model, 'claude-sonnet-5');
    assert.equal(config.name, 'claude-subscription-default');
    // The PINNED Anthropic host, which no input can move — the security property as a value.
    assert.deepEqual(config.endpoint, {
      apiType: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      credential: { kind: 'oauth', value: 'sk-ant-oat01-live' },
    });
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
    assert.equal(viaAuto.endpoint.credential.kind, 'oauth');
    assert.equal(viaAuto.name, 'auto→claude-subscription');
  });
});

// [LAW:single-enforcer] The provider table and the adapter capability declarations are two
// representations of one fact — what a given engine can be pointed at. Nothing in the RUNTIME
// re-checks the static table, so this is the check: a row naming an endpoint kind or auth method its
// engine does not declare would fail only at spawn time, on a real PR, having already paid for the
// prompt. [FRAMING:representation]
// action.yml supplying `default: "https://api.deepseek.com/anthropic"` for DEEPSEEK_BASE_URL is a
// SECOND map of a fact src/provider.js already owns, and the one that wins: core.getInput hands the
// action.yml default over, so the preset's own default becomes unreachable and a change to it does
// nothing. Two clocks, and the wrong one is authoritative. This is the machine that keeps the copy
// from coming back. [LAW:one-source-of-truth]
describe('action.yml does not restate a default that src/provider.js owns', () => {
  const fs = require('fs');
  const path = require('path');
  const yaml = require('yaml');
  const { PROVIDERS, PRESETS } = require('../src/provider');

  const owned = new Map();
  for (const [n, p] of Object.entries(PRESETS)) owned.set(p.baseUrl || p.defaultBaseUrl, `PRESETS.${n}`);
  for (const [n, s] of Object.entries(PROVIDERS)) owned.set(s.defaultModel, `PROVIDERS.${n}.defaultModel`);

  const inputs = yaml.parse(fs.readFileSync(path.resolve(__dirname, '..', 'action.yml'), 'utf8')).inputs;

  for (const [name, spec] of Object.entries(inputs)) {
    test(`'${name}' declares no default that duplicates the provider tables`, () => {
      const source = owned.get(spec.default);
      assert.ok(
        source === undefined,
        `action.yml input '${name}' hardcodes ${JSON.stringify(spec.default)}, which ${source} already owns. ` +
        'Drop the `default:` — an unset input arrives as "" and the resolver reads that as "not set".',
      );
    });
  }

  // The README is the other copy, and it CANNOT be deleted — a consumer reading the inputs table
  // needs the literal value. So the invariant flips direction: the README must not document a
  // default the code no longer produces. Change `deepseek-v4-pro` in PROVIDERS and this fails until
  // the docs follow, which is the drift the action.yml half can't see. [FRAMING:representation]
  const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  for (const [value, source] of owned) {
    test(`README documents the current value of ${source}`, () => {
      assert.ok(
        readme.includes(value),
        `${source} is '${value}', which appears nowhere in README.md — the docs still describe an older default.`,
      );
    });
  }
});

describe('PROVIDERS rows agree with the real adapter capabilities', () => {
  const realRegistry = require('../src/engine/registry');
  const { PROVIDERS, PRESETS } = require('../src/provider');

  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`'${name}': its preset exists and the engine declares that apiType + credential kind`, () => {
      const preset = PRESETS[spec.preset];
      assert.ok(preset, `provider '${name}' names preset '${spec.preset}', which is not defined`);
      const caps = realRegistry.get(spec.engine).capabilities;
      assert.ok(
        caps.apiTypes.includes(preset.apiType),
        `apiType '${preset.apiType}' not in [${caps.apiTypes.join(', ')}]`,
      );
      assert.ok(
        caps.credentialKinds.includes(preset.credentialKind),
        `credentialKind '${preset.credentialKind}' not in [${caps.credentialKinds.join(', ')}]`,
      );
    });

    // A provider whose preset PINS its base URL must not also read a base-URL input — that input
    // would be silently ignored, which is how someone comes to believe they redirected an endpoint
    // they did not. [LAW:no-silent-failure]
    test(`'${name}': reads a base-URL input only if its preset allows an override`, () => {
      const preset = PRESETS[spec.preset];
      if ('baseUrl' in preset) {
        assert.ok(
          !('baseUrl' in spec.inputKeys),
          `pinned preset '${spec.preset}' must not declare a base-URL input key`,
        );
      }
    });
  }
});

// assertProvidersSafe carries a security-critical routing invariant: `inputKeys.credential` names the
// input bag key a row's credential is read out of, so a row without one routes a request to a pinned
// host with a credential nothing can supply. Until this block the throw had no test — test/config.test.js
// exercises only the sibling unknown-preset arm — which left the guard's own failure path unexecuted.
//
// Asserted against the contract (refused at load, with a message naming the offending row), not against
// how the check is spelled. [LAW:behavior-not-structure] [LAW:verifiable-goals]
describe('assertProvidersSafe — a row must name its credential input, its engine, and its default model', () => {
  const rowsMissingCredential = {
    'inputKeys absent entirely': { preset: 'claude-subscription' },
    'inputKeys present but credential absent': { preset: 'claude-subscription', inputKeys: {} },
    'credential set to the empty string': { preset: 'claude-subscription', inputKeys: { credential: '' } },
    'credential set to a non-string': { preset: 'claude-subscription', inputKeys: { credential: 42 } },
  };

  for (const [shape, spec] of Object.entries(rowsMissingCredential)) {
    test(`refused at load: ${shape}`, () => {
      assert.throws(
        () => assertProvidersSafe({ unroutable: spec }, PRESETS),
        { message: /Provider 'unroutable': 'inputKeys\.credential' must name the action input/ },
      );
    });
  }

  // `engine` and `defaultModel` are checked at the same border and for the same reason. Both reach
  // consumers through interpolation — eval/freeze-case.sh stamps `${row.engine}` into the provenance
  // string of every case it freezes — where a missing field arrives as the literal text "undefined",
  // passes every non-empty check downstream, and is written into a committed case.json as the name of
  // the engine that produced it. Refusing the row here is what makes that string unrepresentable, so
  // no consumer has to check for the word "undefined". [LAW:parse-dont-validate]
  const rowsMissingProvenance = {
    'engine absent': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, defaultModel: 'm' },
    'engine empty': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, engine: '', defaultModel: 'm' },
    'engine non-string': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, engine: 7, defaultModel: 'm' },
    'defaultModel absent': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, engine: 'claude-code' },
    'defaultModel empty': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, engine: 'claude-code', defaultModel: '' },
    'defaultModel non-string': { preset: 'claude-subscription', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'T' }, engine: 'claude-code', defaultModel: 7 },
  };
  for (const [shape, spec] of Object.entries(rowsMissingProvenance)) {
    test(`refused at load: ${shape}`, () => {
      assert.throws(
        () => assertProvidersSafe({ unstampable: spec }, PRESETS),
        { message: /Provider 'unstampable': '(engine|defaultModel)' must be a non-empty string/ },
      );
    });
  }

  // `inputKeys.credential` names the input-bag KEY; `credentialInput` names the ENV VAR the credential is
  // actually read from (`env[spec.credentialInput]`). Validating the first and not the second left a row
  // whose credential can never be found failing later as an empty-key env miss, reported as "credential
  // not set" with the real cause — a malformed row — named nowhere. [LAW:no-silent-failure]
  const rowsMissingCredentialInput = {
    'credentialInput absent': { preset: 'claude-subscription', engine: 'claude-code', defaultModel: 'm', inputKeys: { credential: 'T' } },
    'credentialInput empty': { preset: 'claude-subscription', engine: 'claude-code', defaultModel: 'm', credentialInput: '', inputKeys: { credential: 'T' } },
    'credentialInput non-string': { preset: 'claude-subscription', engine: 'claude-code', defaultModel: 'm', credentialInput: 7, inputKeys: { credential: 'T' } },
  };
  for (const [shape, spec] of Object.entries(rowsMissingCredentialInput)) {
    test(`refused at load: ${shape}`, () => {
      assert.throws(
        () => assertProvidersSafe({ unreadable: spec }, PRESETS),
        { message: /Provider 'unreadable': 'credentialInput' must name the environment variable/ },
      );
    });
  }

  test('a complete row passes, and is frozen on the way out', () => {
    const table = { fine: { preset: 'claude-subscription', engine: 'claude-code', defaultModel: 'm', credentialInput: 'SOME_TOKEN', inputKeys: { credential: 'someToken' } } };
    const frozen = assertProvidersSafe(table, PRESETS);
    assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.fine) && Object.isFrozen(frozen.fine.inputKeys));
  });

  // The shipped table is the one that actually routes credentials, so it is the one that must hold.
  test('every shipped provider row names its credential input, its engine, and its default model', () => {
    for (const [name, spec] of Object.entries(PROVIDERS)) {
      assert.equal(typeof spec.inputKeys.credential, 'string', `provider row '${name}'`);
      assert.notEqual(spec.inputKeys.credential, '', `provider row '${name}'`);
      for (const field of ['engine', 'defaultModel', 'credentialInput']) {
        assert.equal(typeof spec[field], 'string', `provider row '${name}'.${field}`);
        assert.notEqual(spec[field], '', `provider row '${name}'.${field}`);
      }
    }
  });
});

// [LAW:verifiable-goals] Every field a row DECLARES must arrive at its destination, and every field it
// does NOT declare must arrive nowhere. Until now only `credential` and `model` were ever carried
// end-to-end, and only across claude-subscription's two-field row — so a scrambled
// `Object.entries(spec.inputKeys)` mapping was caught for the first two fields of one provider and for
// nothing else. The table drives both halves, so the row added tomorrow is covered the day it lands
// rather than the day someone notices its third field never arrived.
describe('resolveProviderConfig threads exactly the fields a provider row declares', () => {
  const { resolveProviderConfig } = require('../src/provider');
  const registry = require('../src/engine/registry');
  // Where each optional field lands, and a value legal for it. `reasoning` is validated against the
  // engine's own capability list, so its value is read from there rather than guessed per provider.
  const FIELD = {
    reasoning: {
      value: spec => registry.get(spec.engine).capabilities.reasoningEfforts[0],
      lands: config => config.reasoning,
    },
    systemPrompt: { value: () => 'pinned-system-prompt', lands: config => config.systemPrompt },
    baseUrl: { value: () => 'http://gateway.example/v1', lands: config => config.endpoint.baseUrl },
  };

  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const declared = Object.keys(spec.inputKeys).filter(f => f in FIELD);

    for (const field of declared) {
      test(`'${name}' declares '${field}', so a pinned '${field}' reaches the config`, () => {
        const value = FIELD[field].value(spec);
        const config = resolveProviderConfig({
          provider: name, [field]: value, env: { [spec.credentialInput]: 'test-credential' },
        });
        assert.strictEqual(FIELD[field].lands(config), value);
      });
    }

    for (const field of Object.keys(FIELD).filter(f => !declared.includes(f))) {
      test(`'${name}' declares no '${field}' key, so a supplied '${field}' reaches nothing`, () => {
        // The other half of the enumeration. claude-subscription's pinned host is the case that matters:
        // a baseUrl it never declared must not become the endpoint a credential is sent to, whatever the
        // caller passes. [LAW:single-enforcer]
        const config = resolveProviderConfig({
          provider: name, [field]: FIELD[field].value(spec), env: { [spec.credentialInput]: 'test-credential' },
        });
        assert.notStrictEqual(FIELD[field].lands(config), FIELD[field].value(spec));
      });
    }
  }

  // `model` deliberately stays OUT of FIELD, and the reason is the whole value of this test. The sweep
  // above reads `declared` from the very table it is checking, so deleting a row's `model` key fails
  // nothing: the row silently crosses from the accept half to the reject half, where the fallback to
  // `defaultModel` makes the reject assertion pass — same test count, all green, mapping gone. A map that
  // is its own territory cannot show drift. [LAW:one-source-of-truth]
  // Taking a model override is a contract over the WHOLE table rather than a field a row may or may not
  // declare, so it is asserted unconditionally, from outside `inputKeys` — which is what makes a dropped
  // mapping visible. [LAW:behavior-not-structure]
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`'${name}' threads a pinned model override, whatever its row declares`, () => {
      const config = resolveProviderConfig({
        provider: name, model: 'test-model-override', env: { [spec.credentialInput]: 'test-credential' },
      });
      assert.strictEqual(config.model, 'test-model-override');
    });
  }
});

// The NO_PROVIDER fallback is reachable from two real non-Action callers — a typo'd `provider` in a
// case.json through eval/run-case.js, and a `--provider` typo through scripts/local-review.js — and it
// exists so an unknown name reaches synthesizeProviderConfig's own "Unknown PROVIDER" error instead of
// crashing on `Object.entries(undefined)`. That is a contract about which error the operator sees, and
// nothing exercised it. [LAW:verifiable-goals]
describe('resolveProviderConfig hands an unknown provider to the one enforcer that rejects it', () => {
  const { resolveProviderConfig } = require('../src/provider');

  test('a typo resolves to the Unknown PROVIDER error, naming every valid value', () => {
    assert.throws(
      () => resolveProviderConfig({ provider: 'claude-subscripton', env: {} }),
      err => /Unknown PROVIDER "claude-subscripton"/.test(err.message) && PROVIDER_NAMES.every(n => err.message.includes(n)),
    );
  });

  test('an absent provider fails the same way rather than throwing on an undefined row', () => {
    assert.throws(() => resolveProviderConfig({ env: {} }), /Unknown PROVIDER/);
  });
});
