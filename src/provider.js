'use strict';
const { ZAI_ANTHROPIC_BASE_URL } = require('./engine/claude-code');
const { OPENAI_RESPONSES_BASE_URL } = require('./engine/codex');
const defaultRegistry = require('./engine/registry');

// DeepSeek exposes an Anthropic-compatible endpoint, so it runs on the claude-code engine
// exactly like z.ai — same auth translation, different base URL. [LAW:one-type-per-behavior]
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

// The default model for a Claude Pro/Max subscription run. Sonnet, not Opus: the constraint under a
// subscription is quota rather than dollars, and a reviewer that exhausts the plan's Opus allowance in
// a morning is worse than one that keeps running. Consumers override with the CLAUDE_MODEL input.
const CLAUDE_SUBSCRIPTION_DEFAULT_MODEL = 'claude-sonnet-5';

// [LAW:dataflow-not-control-flow] The provider is an explicit value, never inferred from
// which credential happens to be set. [LAW:single-enforcer] This module is the one place
// that turns the simple-mode (no CONFIG_FILE) action inputs into a typed ReviewConfig.
//
// [LAW:one-source-of-truth] Each provider spec names its engine, endpoint, auth method, credential
// input, default model, and how to pull its fields from the flat action-input bag. Adding a provider
// is one entry here — every consumer (validation, error messages, config synthesis) derives
// from this table, so none of them branches on a hardcoded provider name.
const PROVIDERS = {
  codex: {
    engine: 'codex',
    endpointKind: 'openai-responses',
    authMethod: 'api-key',
    defaultBaseUrl: OPENAI_RESPONSES_BASE_URL,
    credentialInput: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4-mini',
    fields: i => ({ credential: i.openaiApiKey, model: i.openaiModel, reasoning: i.openaiReasoning, baseUrl: i.openaiBaseUrl }),
  },
  zai: {
    engine: 'claude-code',
    endpointKind: 'anthropic-messages',
    authMethod: 'api-key',
    defaultBaseUrl: ZAI_ANTHROPIC_BASE_URL,
    credentialInput: 'ZAI_API_KEY',
    defaultModel: 'glm-5.1',
    fields: i => ({ credential: i.zaiApiKey, model: i.zaiModel, systemPrompt: i.zaiSystemPrompt, baseUrl: i.zaiBaseUrl }),
  },
  deepseek: {
    engine: 'claude-code',
    endpointKind: 'anthropic-messages',
    authMethod: 'api-key',
    defaultBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    credentialInput: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    fields: i => ({ credential: i.deepseekApiKey, model: i.deepseekModel, systemPrompt: i.deepseekSystemPrompt, baseUrl: i.deepseekBaseUrl }),
  },
  // Claude Pro/Max subscription: the same claude-code engine as zai/deepseek, reached through a
  // different credential channel rather than a different endpoint. The row carries NO defaultBaseUrl
  // and reads NO base-URL input — a subscription token is only ever valid against Anthropic's own API,
  // and offering a URL knob "for flexibility" would re-admit exactly the state the auth union deletes.
  'claude-subscription': {
    engine: 'claude-code',
    endpointKind: 'anthropic-messages',
    authMethod: 'subscription',
    credentialInput: 'CLAUDE_CODE_OAUTH_TOKEN',
    defaultModel: CLAUDE_SUBSCRIPTION_DEFAULT_MODEL,
    fields: i => ({ credential: i.claudeCodeOauthToken, model: i.claudeModel }),
  },
};

// [LAW:dataflow-not-control-flow] The auth method is a value that SELECTS a builder, not a branch
// inside the synthesizer. Each builder produces only its own variant's fields, which is what keeps
// `baseUrl` off the subscription value — an api-key endpoint and a subscription endpoint are two
// shapes, not one shape with optional halves. [LAW:types-are-the-program]
const AUTH_FROM_INPUTS = {
  'api-key': (spec, f) => ({
    method: 'api-key',
    baseUrl: f.baseUrl || spec.defaultBaseUrl,
    credential: f.credential,
  }),
  subscription: (_spec, f) => ({
    method: 'subscription',
    credential: f.credential,
  }),
};

// [LAW:one-type-per-behavior] 'auto' has no behavior of its own — it forwards to whichever
// concrete provider every client should currently use, so the maintainer can retarget all
// clients pinned to PROVIDER=auto without them editing their workflow. [LAW:one-source-of-truth]
// This single mapping is the one place to retarget it.
// Retargeted deepseek → claude-subscription in 1.42.0. DeepSeek's 2026-08-16 repricing raised every
// rate — cache hits, ~92% of a review's input, by 12x — and this reviewer was burning ~$90/day of real
// money. A subscription review costs plan quota instead. A repo that supplies only DEEPSEEK_API_KEY
// now fails at startup naming CLAUDE_CODE_OAUTH_TOKEN: loudly, before any spend, never by silently
// falling back to a paid provider. That loud failure is exactly what makes retargeting every consumer
// from one line safe to do. [LAW:no-silent-failure]
const PROVIDER_ALIASES = { auto: 'claude-subscription' };

// Every accepted PROVIDER input value: the concrete providers plus the aliases. The order
// matters only for the "valid providers" message in the unknown-PROVIDER error.
const PROVIDER_NAMES = [...Object.keys(PROVIDERS), ...Object.keys(PROVIDER_ALIASES)];

// [LAW:effects-at-boundaries] Pure: maps inputs to a ReviewConfig, touches nothing external.
// [LAW:no-silent-failure] Throws — naming the input to fix — when the provider is unknown,
// the selected provider's credential is absent, or the reasoning effort is unsupported.
// reg is injectable for testing; defaults to the real adapter registry.
function synthesizeProviderConfig(inputs, reg) {
  const registry = reg || defaultRegistry;
  const requested = inputs.provider;
  // [LAW:dataflow-not-control-flow] Resolve the alias to a concrete provider value before any
  // synthesis; everything downstream sees only a real provider, never the alias.
  const provider = PROVIDER_ALIASES[requested] || requested;
  const spec = PROVIDERS[provider];
  if (!spec) {
    throw new Error(
      `Unknown PROVIDER ${JSON.stringify(requested)}. Valid providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }

  const f = spec.fields(inputs);

  // [LAW:no-silent-failure] When 'auto' was used, name both it and what it resolved to so the
  // operator knows which input to set.
  const label = requested === provider ? `'${provider}'` : `'${requested}' (→ '${provider}')`;
  if (!f.credential) {
    throw new Error(
      `PROVIDER ${label} requires a credential, but the '${spec.credentialInput}' input is not set or empty. ` +
      `Set '${spec.credentialInput}', or choose a different provider via the PROVIDER input (valid: ${PROVIDER_NAMES.join(', ')}).`,
    );
  }

  const config = {
    // [FRAMING:representation] The config name reflects what actually ran; an alias is shown as
    // 'auto→deepseek' so the run log and attribution footer stay honest about the resolution.
    name: requested === provider ? `${provider}-default` : `${requested}→${provider}`,
    engine: spec.engine,
    model: f.model || spec.defaultModel,
    endpoint: {
      kind: spec.endpointKind,
      auth: AUTH_FROM_INPUTS[spec.authMethod](spec, f),
    },
  };

  if (f.reasoning) {
    // [LAW:single-enforcer] Reasoning validity is owned by the adapter's capability
    // declaration — the same source the CONFIG_FILE path validates against — so simple
    // mode and config-file mode reject the same illegal values.
    const allowed = registry.get(spec.engine).capabilities.reasoningEfforts;
    if (!allowed.includes(f.reasoning)) {
      throw new Error(
        `PROVIDER '${provider}': reasoning '${f.reasoning}' is not valid for engine '${spec.engine}'. ` +
        `Allowed: ${allowed.join(', ')}.`,
      );
    }
    config.reasoning = f.reasoning;
  }

  if (f.systemPrompt) {
    config.systemPrompt = f.systemPrompt;
  }

  return config;
}

module.exports = { synthesizeProviderConfig, PROVIDERS, PROVIDER_ALIASES, PROVIDER_NAMES, AUTH_FROM_INPUTS };
