'use strict';

// Per-run token/cost reporting.
//
// [LAW:decomposition] Two cohesive concerns live here: the price table (a representation that
// drifts from each provider's real prices and must be hand-maintained) and the pure renderer that
// formats an already-extracted Usage value into the review footer line. Extraction is engine-specific
// and lives in each adapter (engine/codex.js, engine/claude-code.js); this module computes cost from
// tokens × price and formats the footer.
// [LAW:single-enforcer] Token cost is computed in exactly one place: computeCostUsd.

// [LAW:one-source-of-truth] The price table — EVERY priced provider, one table, keyed by the exact
// model id each engine reports (namespaces don't collide: gpt-*, deepseek-*, glm-*). Dollars per ONE
// MILLION tokens, matching each vendor's published per-1M figures so they can be eyeballed against
// the pricing page. PRICE-SENSITIVE: these drift whenever a vendor changes prices and have no machine
// source — they MUST be updated by hand. `cachedInput` is the discounted prompt-cache rate.
// Sources / last verified:
//   OpenAI   2026-06-14 — https://openai.com/api/pricing/
//   DeepSeek 2026-07-10 — https://api-docs.deepseek.com/quick_start/pricing  (aggressive disk-cache rate)
//   z.ai GLM 2026-06-17 — https://docs.z.ai/guides/overview/pricing
const PRICES_PER_MILLION = {
  'gpt-5.5': { input: 5.00, cachedInput: 0.50, output: 30.00 },
  'gpt-5.4': { input: 2.50, cachedInput: 0.25, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.50 },
  // The tiny cachedInput rates below are DeepSeek's real published disk-cache pricing — a cache hit is
  // priced far below a cache miss — verified 2026-07-10 against the page, an intentional outlier not typos.
  'deepseek-v4-pro': { input: 0.435, cachedInput: 0.003625, output: 0.87 },
  'deepseek-v4-flash': { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  'glm-5.1': { input: 1.40, cachedInput: 0.26, output: 4.40 },
  'glm-4.6': { input: 0.60, cachedInput: 0.11, output: 2.20 },
};

// [LAW:effects-at-boundaries] Pure: tokens + model -> USD, no IO. Returns null (cost unknown)
// when the model has no price-table entry — never a fabricated zero, so a missing price surfaces
// as "unknown" rather than a confident-but-wrong $0.00. [LAW:no-silent-failure]
// inputTokens is the FULL input count (cached included); the cached subset (cachedInputTokens) is
// billed at the discounted cachedInput rate, the remainder at the input rate. Each adapter buckets
// its own raw usage into this shape (codex: cached_input_tokens; claude-code: cache_read at the
// cached rate, fresh + cache_creation at the full rate). output_tokens is priced at the output rate.
function computeCostUsd({ inputTokens, outputTokens, cachedInputTokens = 0 }, model) {
  const price = PRICES_PER_MILLION[model];
  if (!price) return null;
  const nonCachedInput = Math.max(0, inputTokens - cachedInputTokens);
  const total =
    nonCachedInput * price.input +
    cachedInputTokens * price.cachedInput +
    outputTokens * price.output;
  const usd = total / 1_000_000;
  // [LAW:types-are-the-program] Non-finite input (a NaN token count) yields no usable price, not a NaN
  // "cost": return null so the caller renders it unavailable, keeping available:true ⟹ finite usd.
  return Number.isFinite(usd) ? usd : null;
}

// Claude Code self-reports total_cost_usd using Anthropic's price table, so that figure is this
// run's billing basis ONLY when the engine truly talks to Anthropic. Against an Anthropic-COMPATIBLE
// endpoint (z.ai, deepseek, …) it is priced for the wrong vendor and is not a usable cost.
// [LAW:types-are-the-program] Whitelist the genuine endpoint rather than blacklisting known
// impostors: default to "not Anthropic" so every foreign endpoint is excluded by construction, not
// one vendor at a time. An absent baseUrl means Claude Code's built-in default — Anthropic's own API.
function isAnthropicEndpoint(config) {
  const auth = (config.endpoint && config.endpoint.auth) || {};
  // [LAW:types-are-the-program] A subscription token is minted against Anthropic and the variant
  // carries no baseUrl to point elsewhere, so this question is answered by the type rather than by
  // parsing a hostname. The sniff below exists only for the api-key variant, where a base URL exists
  // and may belong to an Anthropic-COMPATIBLE vendor whose bill is not Anthropic's.
  if (auth.method === 'subscription') return true;
  const baseUrl = auth.baseUrl;
  if (!baseUrl) return true;
  try {
    // [LAW:types-are-the-program] Match the anthropic.com domain exactly — the apex or a true
    // subdomain — never a bare `endsWith('anthropic.com')`, which a lookalike host like
    // `notanthropic.com` would satisfy and be wrongly trusted as Anthropic's billing basis.
    const host = new URL(baseUrl).hostname;
    return host === 'anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

function formatTokenCount(n) {
  return n.toLocaleString('en-US');
}

function reviewerTag(config) {
  return `${config.engine}/${config.model || '(default model)'}`;
}

// [LAW:effects-at-boundaries] Pure: render the cost footer line from a Usage value, or '' when
// there is no usage to report. The "loud" warning for missing usage/price is an effect and
// belongs at the run boundary (src/run.js); costWarning below produces its text, also purely.
// [LAW:dataflow-not-control-flow] usage === null and an unavailable cost are distinct values with
// distinct renderings, not branches that skip work: no usage -> no line; cost unavailable ->
// tokens with cost "unknown".
// [LAW:types-are-the-program] A machine-readable cost record embedded in each review body, so a later
// round sums prior rounds from a typed value — never by re-parsing the rendered "Cost: $X" prose, which
// would be a representation re-parsing itself. Rendered as an HTML comment (invisible, like REVIEW_MARKER)
// and placed in the footer BEFORE REVIEW_MARKER, so the trailing-marker round-count contract is untouched.
// An unavailable or absent cost records 'unknown' — the round is still counted, its cost just isn't summed.
// [LAW:types-are-the-program] The value is a strict non-negative decimal (digits, one optional
// fractional part) or the literal 'unknown' — NOT a loose `[0-9.]+`, which would match '.', '1.2.3',
// or '123..456', all of which Number() turns into NaN. Cost is non-negative by construction, so no
// leading '-'; no exponent, so no Infinity. The producer (costMarker) always emits toFixed(6), which
// satisfies this; the strict pattern rejects a corrupted marker at the boundary.
const COST_MARKER_RE = /<!-- agent-review-cost-usd:([0-9]+(?:\.[0-9]+)?|unknown) -->/g;
function costMarker(cost) {
  // [LAW:types-are-the-program] The marker never carries a non-number: a finite available cost renders
  // as a decimal, everything else (unavailable, or a non-finite usd from a broken upstream) as 'unknown'
  // — symmetric with parseCostMarker's finiteness guard, so the round-trip can never smuggle a NaN.
  const value = cost && cost.available && Number.isFinite(cost.usd) ? cost.usd.toFixed(6) : 'unknown';
  return `<!-- agent-review-cost-usd:${value} -->`;
}
function parseCostMarker(body) {
  if (typeof body !== 'string') return null; // not a marker-bearing body (human review, old review)
  // [LAW:one-source-of-truth] The authoritative marker is the LAST one in the body — it lives in the
  // footer, after all summary/finding prose. A review that QUOTES a marker in its prose (e.g. a review
  // OF this feature) would otherwise let a first-match grab the wrong one. Take the final match.
  const matches = [...body.matchAll(COST_MARKER_RE)];
  if (matches.length === 0) return null;
  const value = matches[matches.length - 1][1];
  if (value === 'unknown') return 'unknown';
  const n = Number(value);
  // [LAW:no-silent-failure] belt to the strict regex: a value that does not parse to a finite number
  // is null (→ counted as an unknown-cost round), never a NaN summed into and poisoning the PR total.
  return Number.isFinite(n) ? n : null;
}

// [LAW:effects-at-boundaries] Pure: the " · PR total ..." clause appended to the cost line, or '' when
// there are no prior rounds (the first review — its single-round line stands alone, unchanged). The
// clause is a VALUE keyed on the prior-round count, not a second footer format. [LAW:no-silent-failure]
// a round with unknown cost is NOT dropped from the count — the total carries a '+' and names how many
// rounds are unpriced, so the PR total is honestly a lower bound rather than a silently-partial sum.
function renderPrTotal(thisCost, priorCost) {
  if (!priorCost) return '';
  const priorRounds = priorCost.knownRounds + priorCost.unknownRounds;
  if (priorRounds === 0) return '';
  const totalUsd = priorCost.usd + (thisCost.available ? thisCost.usd : 0);
  const unknownRounds = priorCost.unknownRounds + (thisCost.available ? 0 : 1);
  const rounds = priorRounds + 1;
  const approx = unknownRounds > 0 ? '+' : '';
  const note = unknownRounds > 0 ? `, ${unknownRounds} with unknown cost` : '';
  return ` · PR total $${totalUsd.toFixed(4)}${approx} across ${rounds} rounds${note}`;
}

function renderCostLine(usage, config, priorCost = null) {
  if (!usage) return '';
  const tag = reviewerTag(config);
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out tokens`;
  const prTotal = renderPrTotal(usage.cost, priorCost);
  if (!usage.cost.available) {
    return `_Cost: unknown · ${tokens} · ${tag}${prTotal}_`;
  }
  // [FRAMING:representation] Every available cost this action renders is an ESTIMATE, never a billed
  // charge: a table-priced provider (codex, deepseek, z.ai) is price-table × tokens; a genuine
  // Anthropic run is Claude Code's own client-side total_cost_usd. So every line is marked "est."
  // rather than implying exactness.
  return `_Cost: $${usage.cost.usd.toFixed(4)} · ${tokens} · ${tag} · est.${prTotal}_`;
}

// [LAW:effects-at-boundaries] Pure: the text of the "cost unavailable" warning, or null when cost
// is fully reported. [LAW:no-silent-failure] the message names the ACTUAL cause, dispatched on the
// reason VALUE the adapter carried — never re-derived by branching on engine at the boundary. This
// is why the reason lives in usage.cost: run.js stays ignorant of which engines are table-priced.
function costWarning(usage, config) {
  if (!usage) return 'Engine reported no token usage; the review footer omits the cost line.';
  if (usage.cost.available) return null;
  const tag = reviewerTag(config);
  if (usage.cost.reason === 'no-price') {
    return `No price-table entry for ${tag}; the review footer shows cost as "unknown". `
      + 'Add the model to PRICES_PER_MILLION in src/usage.js.';
  }
  return `${config.engine} reported no cost (no USD in its output) for ${tag}; `
    + 'the review footer shows cost as "unknown".';
}

module.exports = {
  PRICES_PER_MILLION,
  computeCostUsd,
  renderCostLine,
  renderPrTotal,
  costMarker,
  parseCostMarker,
  costWarning,
  formatTokenCount,
  isAnthropicEndpoint,
};
