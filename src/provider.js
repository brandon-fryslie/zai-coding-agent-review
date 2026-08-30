'use strict';

// [LAW:one-way-deps] This module requires NO engine module. The vendor base URLs below used to be
// declared in the adapters and imported back here — but neither adapter ever USED its own constant;
// each only exported one for PRESETS to read. So the table of endpoint shapes was dragging in the
// whole engine stack (registry → three adapters → cli/run/collector/failover/usage) to learn a
// string it is itself the table of. A vendor's URL is a fact about the vendor, not about the CLI
// that dials it. They live here now, where PRESETS can be imported for the price of the data.
// [LAW:decomposition]

// DeepSeek and z.ai both expose Anthropic-compatible endpoints, so they run on the claude-code
// engine — same auth translation, different base URL. [LAW:one-type-per-behavior]
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic';
const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1';

// The default model for a Claude Pro/Max subscription run. Sonnet, not Opus: the constraint under a
// subscription is quota rather than dollars, and a reviewer that exhausts the plan's Opus allowance in
// a morning is worse than one that keeps running. Consumers override with the CLAUDE_MODEL input.
const CLAUDE_SUBSCRIPTION_DEFAULT_MODEL = 'claude-sonnet-5';

// Anthropic's own API — the only host a Claude Pro/Max subscription token is valid against.
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// ─── PRESETS: the known-good endpoint shapes, and the security boundary ──────────────────────
//
// [LAW:types-are-the-program] A resolved endpoint is three facts and no optional halves:
//   { apiType, baseUrl, credential: { kind, value } }
// Every endpoint has all three. There is no "subscription has no baseUrl" special case — a
// subscription's baseUrl is simply Anthropic's, and a future non-Anthropic subscription names its own.
//
// THE SECURITY INVARIANT THIS TABLE CARRIES. An OAuth/subscription credential is long-lived and
// broadly scoped — its blast radius dwarfs a per-service API key — so it must only ever be sent to
// the host it was minted for. A row expresses that by which base-URL field it has, and the two are
// mutually exclusive by construction:
//
//   baseUrl        PINNED     — no input and no config file can move it. REQUIRED for oauth.
//   defaultBaseUrl OVERRIDABLE — an input or config file may replace it. api-key ONLY.
//
// So a row that pins cannot also offer an override (the field is absent), and a row that offers an
// override cannot carry oauth (assertPresetsSafe below refuses it at module load, and a test asserts
// the same over the table). The consequence is the property that matters: **no misconfiguration can
// point a subscription token at an arbitrary host** — reaching that state requires adding a row here,
// which is a reviewed code change, not a YAML typo. [LAW:no-silent-failure]
const PRESETS = {
  openai: { apiType: 'openai-responses', defaultBaseUrl: OPENAI_RESPONSES_BASE_URL, credentialKind: 'api-key' },
  zai: { apiType: 'anthropic-messages', defaultBaseUrl: ZAI_ANTHROPIC_BASE_URL, credentialKind: 'api-key' },
  deepseek: { apiType: 'anthropic-messages', defaultBaseUrl: DEEPSEEK_ANTHROPIC_BASE_URL, credentialKind: 'api-key' },
  // Pinned + oauth. Deliberately a preset of its own rather than an "anthropic" preset with a token
  // flavour: an api-key Anthropic endpoint would share this host and apiType and differ ONLY in
  // credential kind, and keeping them separate rows with separate credential inputs is what stops a
  // key meant for one from ever being read as the other.
  'claude-subscription': { apiType: 'anthropic-messages', baseUrl: ANTHROPIC_BASE_URL, credentialKind: 'oauth' },
};

// [LAW:single-enforcer] The invariant is checked once, at module load, over the static table — not
// re-derived per run (that would be a defensive guard on a constant) and not left to CI alone, so an
// unsafe row cannot ship even if the test is deleted. A pinned row is identified by HAVING baseUrl.
//
// It then FREEZES what it validated. A load-time check over a mutable object proves only what the
// table was at import; freezing makes it what the table IS, so `PRESETS['claude-subscription']
// .baseUrl = 'https://evil.example'` from any later code throws instead of silently repointing a
// subscription token. Validation and freezing live together because the guarantee is "validated AND
// unchanged since" — one fact, one enforcer. [LAW:types-are-the-program]
function assertPresetsSafe(presets) {
  for (const [name, p] of Object.entries(presets)) {
    const pinned = 'baseUrl' in p;
    const overridable = 'defaultBaseUrl' in p;
    if (pinned === overridable) {
      throw new Error(`Preset '${name}': must declare exactly one of 'baseUrl' (pinned) or 'defaultBaseUrl' (overridable).`);
    }
    // The declared URL must be a real one. This is what lets resolveEndpoint treat every falsy base
    // URL as "not set" with a single `||`, rather than mixing `??` and `||` and having to reason
    // about which of three sources may legally be empty. [LAW:parse-dont-validate]
    const declared = pinned ? p.baseUrl : p.defaultBaseUrl;
    if (typeof declared !== 'string' || declared === '') {
      throw new Error(
        `Preset '${name}': '${pinned ? 'baseUrl' : 'defaultBaseUrl'}' must be a non-empty string (got ${JSON.stringify(declared)}).`,
      );
    }
    if (p.credentialKind === 'oauth' && !pinned) {
      throw new Error(
        `Preset '${name}': an 'oauth' credential requires a PINNED 'baseUrl'. An overridable base URL would let a ` +
        'misconfiguration send a long-lived subscription token to an arbitrary host.',
      );
    }
    Object.freeze(p);
  }
  return Object.freeze(presets);
}
assertPresetsSafe(PRESETS);

// [LAW:dataflow-not-control-flow] The provider is an explicit value, never inferred from
// which credential happens to be set. [LAW:single-enforcer] This module is the one place
// that turns the simple-mode (no CONFIG_FILE) action inputs into a typed ReviewConfig.
//
// [LAW:one-source-of-truth] Each provider spec names its engine, its endpoint PRESET, credential
// input, default model, and which action-input KEY each of its fields arrives under. Adding a provider
// is one entry here — every consumer (validation, error messages, config synthesis) derives
// from this table, so none of them branches on a hardcoded provider name.
//
// `inputKeys` is DATA, not a closure, because the mapping is read in BOTH directions:
// synthesizeProviderConfig pulls a bag apart with it, and resolveProviderConfig assembles one with it.
// It used to be a per-row `fields: i => ({...})` reader, which meant every caller that had to BUILD a
// bag hand-wrote the same key names again — scripts/local-review.js and eval/run-case.js each carried
// a copy, and the eval copy never grew the subscription's keys when 1.42.0 retargeted `auto`, so the
// measurement harness could not reach the provider production actually runs on. A name declared once
// cannot drift from itself.
//
// Each provider has its OWN credential input. That is the other half of the security invariant: the
// PROVIDER value alone selects the row, credential presence never steers it, so a DeepSeek key can
// never be read into the subscription's slot nor a subscription token into DeepSeek's.
const PROVIDERS = {
  codex: {
    engine: 'codex',
    preset: 'openai',
    credentialInput: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4-mini',
    inputKeys: { credential: 'openaiApiKey', model: 'openaiModel', reasoning: 'openaiReasoning', baseUrl: 'openaiBaseUrl' },
  },
  zai: {
    engine: 'claude-code',
    preset: 'zai',
    credentialInput: 'ZAI_API_KEY',
    defaultModel: 'glm-5.1',
    inputKeys: { credential: 'zaiApiKey', model: 'zaiModel', systemPrompt: 'zaiSystemPrompt', baseUrl: 'zaiBaseUrl' },
  },
  deepseek: {
    engine: 'claude-code',
    preset: 'deepseek',
    credentialInput: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-pro',
    inputKeys: { credential: 'deepseekApiKey', model: 'deepseekModel', systemPrompt: 'deepseekSystemPrompt', baseUrl: 'deepseekBaseUrl' },
  },
  // Claude Pro/Max subscription: the same claude-code engine as zai/deepseek, reached with a
  // long-lived OAuth token instead of an API key. It declares NO baseUrl key — there is no
  // CLAUDE_BASE_URL for it to read — so the preset's pinned host stands, in both directions:
  // nothing can be read out of a bag, and resolveProviderConfig writes nothing into one.
  'claude-subscription': {
    engine: 'claude-code',
    preset: 'claude-subscription',
    credentialInput: 'CLAUDE_CODE_OAUTH_TOKEN',
    defaultModel: CLAUDE_SUBSCRIPTION_DEFAULT_MODEL,
    inputKeys: { credential: 'claudeCodeOauthToken', model: 'claudeModel' },
  },
};

// A provider name with no row. [LAW:dataflow-not-control-flow] An absent spec is an EMPTY spec, not a
// branch: reading fields off it yields undefined for every field and writing a bag from it writes no
// keys, so both directions run the same code on a bad name as on a good one — and the one canonical
// "Unknown PROVIDER" error still comes from synthesizeProviderConfig, which owns that diagnosis.
const NO_PROVIDER = Object.freeze({ credentialInput: '', inputKeys: Object.freeze({}) });

// [LAW:single-enforcer] PROVIDERS carries the SAME security-critical routing as PRESETS: `preset`
// picks which endpoint row a credential is sent to, and `inputKeys.credential` names the bag key that
// credential is pulled from. Freezing one table and not the other would leave the invariant
// half-held — `PROVIDERS['claude-subscription'].preset = 'openai'` is as good as repointing the
// pinned host. It validates first, for the same reason assertPresetsSafe does: the guarantee is
// "validated AND unchanged since", which is one fact and wants one enforcer.
function assertProvidersSafe(providers, presets) {
  for (const [name, spec] of Object.entries(providers)) {
    if (!presets[spec.preset]) {
      throw new Error(
        `Provider '${name}': names preset '${spec.preset}', which is not defined. Defined: ${Object.keys(presets).join(', ')}.`,
      );
    }
    // A row with no credential key is a row whose credential can never be read out of an input bag —
    // synthesizeProviderConfig would reject every call to it as "credential not set", with a message
    // naming an input nothing writes. Refuse it at load, where the table is, not per run.
    // [LAW:no-silent-failure]
    if (typeof spec.inputKeys?.credential !== 'string' || spec.inputKeys.credential === '') {
      throw new Error(`Provider '${name}': 'inputKeys.credential' must name the action input its credential arrives under.`);
    }
    Object.freeze(spec.inputKeys);
    Object.freeze(spec);
  }
  return Object.freeze(providers);
}
assertProvidersSafe(PROVIDERS, PRESETS);

// [LAW:dataflow-not-control-flow] Resolve a preset plus the caller's overrides into the one endpoint
// shape. A pinned preset ignores no input — it is handed none, because `fields` on a pinned row reads
// no base URL. The chain therefore has exactly one live source per row, never a silent priority
// contest between a pin and an override.
//
// `||`, not `??`, and deliberately: the override arrives from `core.getInput`, which yields '' for an
// input the workflow left unset or interpolated from an empty `${{ vars.X }}`. Under `??` that ''
// wins the chain and the run spawns against an EMPTY base URL — a broken endpoint produced by a
// blank field, which is precisely the silent failure this module exists to prevent. Falsy therefore
// means "not set" for all three sources; assertPresetsSafe guarantees a preset's own URL is never
// falsy, so `||` and `??` differ only on the case that must not win. [LAW:no-silent-failure]
function resolveEndpoint(preset, { baseUrl, credential }) {
  return {
    apiType: preset.apiType,
    baseUrl: preset.baseUrl || baseUrl || preset.defaultBaseUrl,
    credential: { kind: preset.credentialKind, value: credential },
  };
}

// [LAW:one-type-per-behavior] 'auto' has no behavior of its own — it forwards to whichever
// concrete provider every client should currently use, so the maintainer can retarget all
// clients pinned to PROVIDER=auto without them editing their workflow. [LAW:one-source-of-truth]
// This single mapping is the one place to retarget it.
// Retargeted deepseek → claude-subscription in 1.42.0. DeepSeek's 2026-08-16 repricing raised every
// rate — cache hits, ~92% of a review's input, by 12x — and this reviewer was burning ~$90/day of real
// money. A subscription review costs plan quota instead. A repo that supplies only DEEPSEEK_API_KEY
// now fails at startup naming CLAUDE_CODE_OAUTH_TOKEN: loudly, before any spend, never by silently
// falling back to a paid provider. That loud failure is exactly what makes retargeting every consumer
// from one line safe to do. [LAW:no-silent-failure] The installer provisions both secrets, so a
// workflow it wrote carries whichever credential 'auto' currently resolves to.
// Frozen with the two tables it steers between: reassigning `auto` reroutes every consumer that
// named no provider, which is the same blast radius as repointing a row.
const PROVIDER_ALIASES = Object.freeze({ auto: 'claude-subscription' });

// Every accepted PROVIDER input value: the concrete providers plus the aliases. The order
// matters only for the "valid providers" message in the unknown-PROVIDER error.
const PROVIDER_NAMES = [...Object.keys(PROVIDERS), ...Object.keys(PROVIDER_ALIASES)];

// [LAW:effects-at-boundaries] Pure: read one provider's fields out of the flat action-input bag, under
// the key names its row declares. A field the row does not declare is simply absent — a subscription
// spec names no baseUrl key, so no baseUrl can be read for it whatever the bag happens to contain.
function readProviderFields(spec, inputs) {
  const fields = {};
  for (const [field, key] of Object.entries(spec.inputKeys)) fields[field] = inputs[key];
  return fields;
}

// [LAW:decomposition] One job: resolve a provider name plus overrides into a ReviewConfig, reading the
// provider's credential from the environment. This is the seam every NON-ACTION entry point uses —
// scripts/local-review.js and eval/run-case.js — so the flat input bag, which is an artifact of the
// ACTION's interface, is constructed in exactly one place instead of hand-written at each of them.
// [LAW:one-source-of-truth] The bag those two used to build by hand had already drifted apart; this is
// the seam whose absence let it. An overriding `model`/`baseUrl` of undefined leaves the row's own
// default standing, exactly as an unset action input does.
// [LAW:effects-at-boundaries] `env` is a parameter, not a read of process.env, so this stays pure.
function resolveProviderConfig({ provider, model, reasoning, baseUrl, systemPrompt, env }, reg) {
  const spec = PROVIDERS[PROVIDER_ALIASES[provider] || provider] || NO_PROVIDER;
  const values = { credential: env[spec.credentialInput], model, reasoning, baseUrl, systemPrompt };
  const inputs = { provider };
  for (const [field, key] of Object.entries(spec.inputKeys)) inputs[key] = values[field];
  return synthesizeProviderConfig(inputs, reg);
}

// [LAW:effects-at-boundaries] Pure: maps inputs to a ReviewConfig, touches nothing external.
// [LAW:no-silent-failure] Throws — naming the input to fix — when the provider is unknown,
// the selected provider's credential is absent, or the reasoning effort is unsupported.
// reg is injectable for testing; defaults to the real adapter registry, required at the ONE point
// that needs it (see the one-way-deps note at the top) so importing this module stays data-cheap.
function synthesizeProviderConfig(inputs, reg) {
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

  const f = readProviderFields(spec, inputs);

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
    endpoint: resolveEndpoint(PRESETS[spec.preset], f),
  };

  if (f.reasoning) {
    // [LAW:single-enforcer] Reasoning validity is owned by the adapter's capability
    // declaration — the same source the CONFIG_FILE path validates against — so simple
    // mode and config-file mode reject the same illegal values.
    const registry = reg || require('./engine/registry');
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

module.exports = {
  synthesizeProviderConfig,
  resolveProviderConfig,
  PROVIDERS,
  PROVIDER_ALIASES,
  PROVIDER_NAMES,
  // PRESETS + resolveEndpoint are shared with the config-file path (src/config.js): a config file's
  // `preset:` form resolves through the SAME table, so the pinned-host guarantee cannot be bypassed
  // by writing YAML instead of setting an input. [LAW:single-enforcer]
  PRESETS,
  resolveEndpoint,
  assertPresetsSafe,
  assertProvidersSafe,
};
