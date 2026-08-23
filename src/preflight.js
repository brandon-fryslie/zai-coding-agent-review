'use strict';

// Cheap connectivity + auth probe run before the expensive engine spawn. When a provider
// credential or endpoint is misconfigured, the review otherwise fails deep inside the agent CLI
// with a cryptic error; this surfaces the precise cause (bad key, unreachable endpoint, wrong URL)
// in one line, fast and nearly free. [LAW:no-silent-failure]

const PROBE_TIMEOUT_MS = 10000;

// [LAW:effects-at-boundaries] Pure core: maps a probe outcome — an HTTP status, or a thrown
// network error — to a verdict. The network effect lives in probeConfig; this is the testable part.
// Classification is grounded in observed behaviour of a live Anthropic-compatible endpoint:
// 200 = healthy, 401 = bad/expired key, DNS/connection failure = unreachable.
function classifyProbe({ status, networkError }) {
  if (networkError) {
    return {
      healthy: false,
      reason: 'unreachable',
      hint: `could not reach the endpoint (${networkError}) — check the base URL and the runner's network egress`,
    };
  }
  if (status >= 200 && status < 300) {
    return { healthy: true, reason: 'ok', hint: null };
  }
  if (status === 401 || status === 403) {
    return {
      healthy: false,
      reason: 'auth',
      hint: `endpoint rejected the credential (HTTP ${status}) — the API key is missing, wrong, or expired`,
    };
  }
  if (status === 404) {
    return {
      healthy: false,
      reason: 'endpoint',
      hint: `endpoint returned 404 — check the base URL, and that the model name exists`,
    };
  }
  // Any other status means the server was reached AND the credential passed (auth failures are
  // 401/403). A 400/5xx here is likely transient or a quirk of the minimal probe body, so it must
  // not block a review that would otherwise work — surface it, but treat the config as usable.
  // [LAW:no-silent-failure] reachable-but-odd is reported, never silently dropped.
  return {
    healthy: true,
    reason: 'reachable',
    hint: `endpoint returned HTTP ${status} to the probe — reachable and authenticated, proceeding`,
  };
}

// The minimal request for an endpoint kind + auth method. Only combinations whose live behaviour has
// been observed are probed; anything else returns null and the caller skips it loudly, rather than
// shipping a probe that could false-fail a working setup. [FRAMING:representation] [LAW:no-silent-failure]
//
// The subscription variant is deliberately unprobed: an OAuth subscription token against the raw
// Messages API needs beta headers whose live behaviour has NOT been observed here, so a guessed probe
// would reject a perfectly working subscription before the engine ever spawned — the exact false
// failure this function's contract exists to avoid.
function probeRequest(endpoint, model) {
  if (endpoint.kind === 'anthropic-messages' && endpoint.auth.method === 'api-key') {
    return {
      url: `${endpoint.auth.baseUrl.replace(/\/+$/, '')}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${endpoint.auth.credential}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      },
    };
  }
  return null;
}

// [LAW:effects-at-boundaries] The one network effect: fetchImpl is injectable so the verdict logic
// is tested without a live endpoint. A timeout is classified as unreachable, the same as a refused
// connection — both mean "the engine won't get through either."
async function probeConfig(config, fetchImpl = fetch) {
  const req = probeRequest(config.endpoint, config.model);
  if (!req) {
    return {
      name: config.name,
      skipped: true,
      // Name BOTH axes: 'anthropic-messages' alone IS probed under api-key auth, so reporting only the
      // kind would read as a contradiction to anyone who has seen the probe run. [LAW:no-silent-failure]
      hint: `no preflight probe is implemented for endpoint kind '${config.endpoint.kind}' with auth method '${config.endpoint.auth.method}'`,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let outcome;
  try {
    const res = await fetchImpl(req.url, { ...req.init, signal: controller.signal });
    outcome = classifyProbe({ status: res.status });
  } catch (e) {
    const networkError = e.name === 'AbortError' ? `timed out after ${PROBE_TIMEOUT_MS}ms` : e.message;
    outcome = classifyProbe({ networkError });
  } finally {
    clearTimeout(timer);
  }
  return { name: config.name, skipped: false, ...outcome };
}

// [LAW:dataflow-not-control-flow] Probe every config in the chain and reduce to one verdict: the
// chain is usable if ANY probed config is healthy — a failover chain exists precisely so a dead
// primary is survivable. A skipped probe (unobserved kind) is neither healthy nor a failure; it is
// reported but never blocks. All-skipped therefore stays ok (nothing was actually validated).
async function preflight(chain, fetchImpl = fetch) {
  const results = [];
  for (const config of chain) {
    // eslint-disable-next-line no-await-in-loop -- chains are tiny (1-3); sequential keeps logs ordered
    results.push(await probeConfig(config, fetchImpl));
  }
  // [LAW:types-are-the-program] A config is in one of three states, and only one of them is evidence
  // against the chain: healthy (proven up), unhealthy (proven down), skipped (UNPROVEN — no probe exists
  // for its endpoint kind + auth method). The chain is usable unless every config is proven down, so a
  // skipped config counts for it, never as if absent.
  //
  // Filtering skipped configs out first made "unproven" indistinguishable from "not there", which
  // false-blocked a real chain: a subscription primary (skipped — an OAuth probe would need beta headers
  // whose behaviour is unobserved here) in front of an api-key fallback with an expired key gave
  // probed=[unhealthy] ⇒ ok=false, so the run was killed before any engine spawned even though failover
  // would have tried the perfectly good subscription first and never reached the dead fallback.
  // This also subsumes the old all-skipped special case rather than needing a clause of its own.
  const ok = results.some(r => r.skipped || r.healthy);
  return { ok, results };
}

module.exports = { preflight, probeConfig, classifyProbe, PROBE_TIMEOUT_MS };
