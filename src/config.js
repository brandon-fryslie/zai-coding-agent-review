'use strict';
const fs = require('fs');
const yaml = require('yaml');
const defaultRegistry = require('./engine/registry');
// [LAW:single-enforcer] The SAME preset table simple mode resolves through. A config file's `preset:`
// form cannot reach an endpoint shape the PROVIDER inputs could not, and in particular cannot pair an
// oauth credential with a host of its own choosing.
const { PRESETS, resolveEndpoint } = require('./provider');

// [LAW:types-are-the-program] The config file schema is the single type contract for
// multi-engine configurations. Every illegal combination (unknown engine, unsupported
// endpoint kind, unsupported auth method, invalid reasoning effort) is caught here at load time.
// [LAW:single-enforcer] This module is the one place that validates engine/endpoint/auth/
// reasoning combinations against adapter capability declarations.

const SUPPORTED_VERSIONS = [1];

// ─── The two endpoint forms a config file may write ──────────────────────────────────────────
//
// [LAW:types-are-the-program] YAML cannot express a discriminated union, so the union is recovered
// here at the boundary. An `endpoint` block is exactly one of two forms, discriminated by `preset`:
//
//   PRESET   { preset, credentialEnv }              — apiType, baseUrl and credentialKind all come
//                                                     from src/provider.js PRESETS. May be oauth.
//   MANUAL   { apiType, baseUrl, credentialEnv }    — total flexibility over the endpoint.
//                                                     ALWAYS api-key; there is no `credentialKind`
//                                                     field for this form to set.
//
// THAT ASYMMETRY IS THE SECURITY BOUNDARY, not an oversight. A long-lived subscription/OAuth token
// must only ever reach the host it was minted for, so oauth is reachable only through a preset whose
// baseUrl is pinned in code. The manual form keeps every degree of freedom that is safe to have —
// any apiType, any baseUrl, any env var — and simply cannot name a high-blast-radius credential.
// Reaching "oauth token at a host of my choosing" therefore requires adding a PRESET, which is a
// reviewed code change rather than a YAML typo. [LAW:no-silent-failure]
const MANUAL_FIELDS = ['apiType', 'baseUrl', 'credentialEnv'];
const PRESET_FIELDS = ['preset', 'credentialEnv'];

// [LAW:no-silent-failure] A key the chosen form does not take is an ERROR, never quietly ignored: a
// `baseUrl` written beside a `preset` is someone believing they redirected a pinned endpoint, and
// dropping it silently would leave that belief intact and wrong.
function rejectForeignKeys(name, endpoint, allowed, formLabel) {
  const extra = Object.keys(endpoint).filter(k => !allowed.includes(k));
  if (extra.length > 0) {
    throw new Error(
      `Config '${name}': endpoint has field(s) ${extra.map(k => `'${k}'`).join(', ')} that the ${formLabel} form does not take. ` +
      `Allowed: ${allowed.map(k => `'${k}'`).join(', ')}.`,
    );
  }
}

function requireFields(name, endpoint, fields) {
  for (const field of fields) {
    if (!endpoint[field]) {
      throw new Error(`Config '${name}': missing required field 'endpoint.${field}'.`);
    }
  }
}

// [LAW:single-enforcer] Endpoint validity is owned by the adapter's capability declaration — the same
// declaration simple mode's provider table is checked against — so both config paths reject
// identically. Which form was written is a value read off the block, not a mode the caller picks.
// [LAW:dataflow-not-control-flow]
function validateEndpoint(name, engine, endpoint, capabilities) {
  const supports = (what, value, allowed) => {
    if (!allowed.includes(value)) {
      throw new Error(
        `Config '${name}': ${what} '${value}' is not supported by engine '${engine}'. Allowed: ${allowed.join(', ')}.`,
      );
    }
  };

  if (endpoint.preset !== undefined) {
    rejectForeignKeys(name, endpoint, PRESET_FIELDS, 'preset');
    requireFields(name, endpoint, PRESET_FIELDS);
    const preset = PRESETS[endpoint.preset];
    if (!preset) {
      throw new Error(
        `Config '${name}': endpoint.preset '${endpoint.preset}' is not a known preset. Defined: ${Object.keys(PRESETS).join(', ')}.`,
      );
    }
    supports('endpoint.apiType', preset.apiType, capabilities.apiTypes);
    supports('the credential kind', preset.credentialKind, capabilities.credentialKinds);
    return;
  }

  rejectForeignKeys(name, endpoint, MANUAL_FIELDS, 'manual');
  requireFields(name, endpoint, MANUAL_FIELDS);
  supports('endpoint.apiType', endpoint.apiType, capabilities.apiTypes);
  // The manual form is api-key by construction — it has no field that could say otherwise — so the
  // engine must support api-key to be reachable this way at all. An engine that only ever took a
  // subscription credential would be configurable solely through a preset, which is the intent.
  supports('the credential kind', 'api-key', capabilities.credentialKinds);
}

// [LAW:effects-at-boundaries] Pure: validates raw parsed YAML against the adapter
// registry. Throws with a message naming the config, field, and allowed values.
// The registry is a parameter so tests can inject stubs.
function validateFile(raw, registry) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file is empty or is not a YAML mapping.`);
  }

  if (!SUPPORTED_VERSIONS.includes(raw.version)) {
    throw new Error(
      `Config file: unknown version ${JSON.stringify(raw.version)}. Supported: ${SUPPORTED_VERSIONS.join(', ')}.`,
    );
  }

  if (!raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`Config file: missing or invalid 'configs' map.`);
  }

  const configNames = Object.keys(raw.configs);

  for (const [name, entry] of Object.entries(raw.configs)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Config '${name}': entry must be an object.`);
    }
    if (!entry.engine) {
      throw new Error(`Config '${name}': missing required field 'engine'.`);
    }

    let adapter;
    try {
      adapter = registry.get(entry.engine);
    } catch (e) {
      // [LAW:no-silent-failure] registry.get already names valid engines in its message
      throw new Error(`Config '${name}': ${e.message}`);
    }

    if (!entry.endpoint || typeof entry.endpoint !== 'object') {
      throw new Error(`Config '${name}': missing required field 'endpoint'.`);
    }
    validateEndpoint(name, entry.engine, entry.endpoint, adapter.capabilities);

    if (entry.reasoning !== undefined && entry.reasoning !== null) {
      if (adapter.capabilities.reasoningEfforts.length === 0) {
        throw new Error(
          `Config '${name}': reasoning '${entry.reasoning}' is not supported by engine '${entry.engine}' (engine declares no reasoning efforts).`,
        );
      }
      if (!adapter.capabilities.reasoningEfforts.includes(entry.reasoning)) {
        throw new Error(
          `Config '${name}': reasoning '${entry.reasoning}' is not valid for engine '${entry.engine}'. Allowed: ${adapter.capabilities.reasoningEfforts.join(', ')}.`,
        );
      }
    }

  }

  if (!raw.default) {
    throw new Error(`Config file: missing required field 'default'.`);
  }

  if (!raw.configs[raw.default]) {
    throw new Error(
      `Config file: default '${raw.default}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
    );
  }

  if (raw.fallback !== undefined && raw.fallback !== null) {
    if (!Array.isArray(raw.fallback)) {
      throw new Error(`Config file: 'fallback' must be an array.`);
    }
    for (const name of raw.fallback) {
      if (!raw.configs[name]) {
        throw new Error(
          `Config file: fallback entry '${name}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
        );
      }
    }
  }
}

// The manual form IS a preset written inline: always api-key, base URL exactly as given. Saying so
// — rather than branching on the form downstream — is what lets ONE resolveEndpoint serve both, and
// is why the manual form can never produce an oauth credential: this is the only place it could come
// from, and it is hardcoded. [LAW:types-are-the-program]
function presetFor(endpoint) {
  return endpoint.preset !== undefined
    ? PRESETS[endpoint.preset]
    : { apiType: endpoint.apiType, baseUrl: endpoint.baseUrl, credentialKind: 'api-key' };
}

// [LAW:dataflow-not-control-flow] Chain is a value: [selected, ...fallback minus selected].
// Pure: no env reads, no side effects.
function resolveChain(raw, selectedName) {
  const chosen = selectedName || raw.default;
  const fallback = raw.fallback || [];
  const names = [chosen, ...fallback.filter(n => n !== chosen)];
  return names.map(name => {
    const entry = raw.configs[name];
    // [LAW:one-source-of-truth] Both forms produce their endpoint through the ONE resolveEndpoint, so
    // a preset endpoint and a manual endpoint cannot drift in shape. Fields are read by name, never
    // spread from the raw block, so a stray key can never ride along into a spawn spec.
    const { apiType, baseUrl, credential } = resolveEndpoint(presetFor(entry.endpoint), {});
    const config = {
      name,
      engine: entry.engine,
      model: entry.model || '',
      // Pre-resolution the credential carries its env var NAME; resolveSecrets swaps env → value.
      // The kind travels with it from the first moment, so nothing downstream has to re-derive
      // how dangerous this credential is.
      endpoint: { apiType, baseUrl, credential: { kind: credential.kind, env: entry.endpoint.credentialEnv } },
    };
    if (entry.reasoning !== undefined && entry.reasoning !== null) {
      config.reasoning = entry.reasoning;
    }
    return config;
  });
}

// [LAW:effects-at-boundaries] Reads env (external state) but accepts it as a value for
// isolation. Throws if any credential env var in the chain is absent or empty so startup fails
// fast rather than at failover time. [LAW:no-silent-failure]
// [LAW:one-type-per-behavior] ONE swap serves every auth mechanism: `env → value` inside the
// credential, leaving its `kind` untouched. There is no per-mechanism code path here, so a mechanism
// added later resolves correctly the day it is added — and, because the kind rides along rather than
// being re-derived downstream, nothing later has to guess how dangerous this credential is.
function resolveSecrets(chain, env) {
  return chain.map(config => {
    const { kind, env: credentialEnv } = config.endpoint.credential;
    const value = env[credentialEnv];
    if (!value) {
      throw new Error(
        `Config '${config.name}': env var '${credentialEnv}' is not set or empty. ` +
        'Ensure the workflow maps a secret to this variable.',
      );
    }
    return { ...config, endpoint: { ...config.endpoint, credential: { kind, value } } };
  });
}

// Load, parse, validate, and resolve a config file into an ordered chain of ReviewConfig
// values with apiKey populated. Throws on any schema error, unknown selected name, or
// missing env var in the chain.
// reg is injectable for testing (defaults to the real adapter registry).
function loadConfig(filePath, selectedName, env, reg) {
  const registry = reg || defaultRegistry;
  let raw;
  try {
    raw = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config file '${filePath}': ${e.message}`);
  }

  validateFile(raw, registry);

  if (selectedName && !raw.configs[selectedName]) {
    const defined = Object.keys(raw.configs).join(', ');
    throw new Error(`Selected config '${selectedName}' not found in '${filePath}'. Defined: ${defined}.`);
  }

  const chain = resolveChain(raw, selectedName);
  return resolveSecrets(chain, env);
}

// Fast read: returns configNames and defaultName without full validation or secret resolution.
// Used by run.js to get config names for PR-level selection before the full loadConfig call.
// [LAW:effects-at-boundaries] Reads the filesystem but accepts filePath as a value.
// [LAW:no-silent-failure] Throws if the file is unreadable or lacks 'configs'/'default'.
function peekConfigNames(filePath) {
  let raw;
  try {
    raw = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read config file '${filePath}': ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Config file '${filePath}': not a YAML mapping.`);
  }
  if (!raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`Config file '${filePath}': missing or invalid 'configs' map.`);
  }
  if (typeof raw.default !== 'string' || !raw.default) {
    throw new Error(`Config file '${filePath}': 'default' must be a non-empty string.`);
  }
  const configNames = Object.keys(raw.configs);
  const defaultName = raw.default;
  if (!configNames.includes(defaultName)) {
    throw new Error(
      `Config file '${filePath}': default '${defaultName}' does not name a defined config. Defined: ${configNames.join(', ')}.`,
    );
  }
  return { configNames, defaultName };
}

module.exports = { loadConfig, validateFile, resolveChain, resolveSecrets, peekConfigNames };
