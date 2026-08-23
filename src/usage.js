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

// [LAW:types-are-the-program] THE COST VALUE. A review's cost is discriminated by its BASIS — the
// question "was this paid in dollars at all?" — because a subscription run's figure is a real,
// exactly-known number that is nonetheless NOT spend:
//
//   { basis: 'dollars',      usd }                                 real money; the ONLY arm a spend fold reads
//   { basis: 'subscription', notionalUsd: number | null }          plan quota; Anthropic LIST PRICE, never spend
//   { basis: 'unpriced',     reason: 'no-price'|'not-reported' }   dollars, but the figure is unrecoverable
//
// The old two-arm shape ({available:true,usd} | {available:false,reason}) could not express a
// subscription run at all: `available:false` says "we do not know", when in fact we know the number
// exactly and it simply is not a charge — so the figure landed in `usd` and every fold downstream
// (PR total, daily ledger, the DAILY_BUDGET_USD gate) added notional dollars to real spend.
//
// The exclusion is STRUCTURAL, not a rule. The notional figure lives under a DIFFERENT NAME on a
// DIFFERENT arm, so a spend fold has no `usd` to read on a subscription cost and cannot pick it up
// even by mistake. One `usd` field shared by both bases plus "remember to check the basis first"
// would be a rule, and a rule gets forgotten exactly once, silently, inside a total.
// [LAW:no-silent-failure] `notionalUsd: null` is the honest fourth state — billed to quota, list
// price not reported — never a fabricated 0.00, which would read as "this was free AND we know it".

// [LAW:single-enforcer] The one predicate answering "does this config pay in plan quota rather than
// dollars?", derived from the credential KIND — never from the hostname. PRESETS pins every oauth
// credential to Anthropic's own baseUrl (assertPresetsSafe, src/provider.js), so an oauth run IS an
// Anthropic run by construction; that is why this decides the basis BEFORE isAnthropicEndpoint's
// whitelist rather than beside it, and why the whitelist below needs no subscription special case.
function isSubscription(config) {
  return config.endpoint?.credential?.kind === 'oauth';
}

// Claude Code self-reports total_cost_usd using Anthropic's price table, so that figure is this
// run's billing basis ONLY when the engine truly talks to Anthropic. Against an Anthropic-COMPATIBLE
// endpoint (z.ai, deepseek, …) it is priced for the wrong vendor and is not a usable cost.
// [LAW:types-are-the-program] Whitelist the genuine endpoint rather than blacklisting known
// impostors: default to "not Anthropic" so every foreign endpoint is excluded by construction, not
// one vendor at a time — which is also why an absent baseUrl answers NO: a config that cannot say
// where it points has not earned Anthropic's billing basis.
function isAnthropicEndpoint(config) {
  // Every endpoint now carries a real baseUrl — an OAuth credential's is PINNED in the preset table
  // rather than absent — so this is a plain hostname whitelist with no special case for a missing URL
  // and none for a subscription. A pinned Anthropic host simply passes the same check every other
  // endpoint takes. [LAW:one-type-per-behavior]
  const baseUrl = config.endpoint && config.endpoint.baseUrl;
  if (!baseUrl) return false;
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
// [LAW:one-source-of-truth] ONE value grammar, shared by both marker names below, so a marker that
// the notional reader accepts can never be one the spend reader would have rejected.
const MARKER_VALUE = '([0-9]+(?:\\.[0-9]+)?|unknown)';

// [LAW:types-are-the-program] THE SPEND EXCLUSION, MADE STRUCTURAL. A subscription review writes a
// DIFFERENTLY NAMED marker, so every spend reader — parseCostMarker here, sumCostToday in ledger.js,
// summarizePriorReviews in transport.js — has literally nothing to match in its body. The notional
// dollars are kept out of the daily spend by the regex, not by a guard someone must remember to
// write, and a future reader who adds a fourth spend fold inherits the exclusion for free.
const COST_MARKER_RE = new RegExp(`<!-- agent-review-cost-usd:${MARKER_VALUE} -->`, 'g');
const NOTIONAL_MARKER_RE = new RegExp(`<!-- agent-review-notional-usd:${MARKER_VALUE} -->`, 'g');

// [LAW:one-source-of-truth] ONE table of what each basis IS, for accounting purposes: which marker
// name carries it, which tally bucket it lands in, and where its figure lives. A separate table per
// consumer could drift — a basis marked notional by the writer and billed by the tally would put
// notional dollars straight back into spend, which is the whole bug. One row, one answer.
// [LAW:dataflow-not-control-flow] The basis selects data (a name, a key, an accessor); the same
// render and the same fold then run for every basis. No arm skips writing a marker, so every review
// round stays countable — a subscription round is a round whose SPEND is known to be zero, not a
// missing one. An absent cost (no usage at all) is accounted as an unpriced one.
const BASIS = {
  dollars: { marker: 'agent-review-cost-usd', bucket: 'billed', figure: c => c.usd },
  subscription: { marker: 'agent-review-notional-usd', bucket: 'notional', figure: c => c.notionalUsd },
  unpriced: { marker: 'agent-review-cost-usd', bucket: 'billed', figure: () => null },
};

function basisOf(cost) {
  return BASIS[cost && cost.basis] || BASIS.unpriced;
}

// [LAW:types-are-the-program] The marker never carries a non-number: a finite figure renders as a
// decimal, everything else (an unpriced cost, an unreported notional, or a non-finite number from a
// broken upstream) as 'unknown' — symmetric with parseMarker's finiteness guard below, so the
// round-trip can never smuggle a NaN.
function costMarker(cost) {
  const basis = basisOf(cost);
  const figure = basis.figure(cost);
  return `<!-- ${basis.marker}:${Number.isFinite(figure) ? figure.toFixed(6) : 'unknown'} -->`;
}

function parseMarker(body, re) {
  if (typeof body !== 'string') return null; // not a marker-bearing body (human review, old review)
  // [LAW:one-source-of-truth] The authoritative marker is the LAST one in the body — it lives in the
  // footer, after all summary/finding prose. A review that QUOTES a marker in its prose (e.g. a review
  // OF this feature) would otherwise let a first-match grab the wrong one. Take the final match.
  const matches = [...body.matchAll(re)];
  if (matches.length === 0) return null;
  const value = matches[matches.length - 1][1];
  if (value === 'unknown') return 'unknown';
  const n = Number(value);
  // [LAW:no-silent-failure] belt to the strict regex: a value that does not parse to a finite number
  // is null (→ counted as an unknown-cost round), never a NaN summed into and poisoning the PR total.
  return Number.isFinite(n) ? n : null;
}

// The spend reader. Matches ONLY the dollars/unpriced marker name, so a subscription review is
// invisible to it by construction — see THE SPEND EXCLUSION above.
function parseCostMarker(body) {
  return parseMarker(body, COST_MARKER_RE);
}

// [LAW:parse-dont-validate] Read a review body's marker back into the SAME Cost value costMarker
// wrote, so the two folds that consume markers (the daily ledger, the PR total) tally a typed value
// instead of each re-deciding what a raw marker string means. Returns null for a body carrying no
// marker at all — a pre-feature review round, whose cost is genuinely unknown rather than zero.
function parseCost(body) {
  const notional = parseMarker(body, NOTIONAL_MARKER_RE);
  if (notional !== null) {
    return { basis: 'subscription', notionalUsd: typeof notional === 'number' ? notional : null };
  }
  const usd = parseCostMarker(body);
  if (usd === null) return null;
  return typeof usd === 'number' ? { basis: 'dollars', usd } : { basis: 'unpriced', reason: 'not-reported' };
}

// [LAW:one-source-of-truth] SUMMING IS THE ONE PLACE the "never add across bases" rule lives. A
// dollar of spend and a notional list-price dollar are different UNITS; adding them yields a number
// that means nothing, which is exactly the bug this ticket exists to kill. [LAW:no-silent-failure]
// A mixed-basis sum resolves to 'unpriced' — an honest "we cannot give you one number" — never a
// silent blend. Within one multi-scope pass the basis is uniform by construction (every spawn runs
// on ONE config), so the mixed arm is unreachable there; it is resolved as a VALUE anyway rather
// than assumed away, because the sum is a pure function and must total whatever it is handed.
// One unpriced spawn makes the whole sum unpriced, carrying THAT spawn's reason, exactly as before.
// A subscription sum with any unreported notional is wholly unreported: a partial list price summed
// as if it were the total would understate the run, which is the same lie in a smaller font.
function sumCost(costs) {
  const unpriced = costs.find(c => c.basis === 'unpriced');
  if (unpriced) return unpriced;
  const bases = new Set(costs.map(c => c.basis));
  if (bases.size !== 1) return { basis: 'unpriced', reason: 'not-reported' };
  if (costs[0].basis === 'subscription') {
    const notionals = costs.map(c => c.notionalUsd);
    return {
      basis: 'subscription',
      notionalUsd: notionals.every(n => Number.isFinite(n)) ? notionals.reduce((sum, n) => sum + n, 0) : null,
    };
  }
  return { basis: 'dollars', usd: costs.reduce((sum, c) => sum + c.usd, 0) };
}

// [LAW:one-type-per-behavior] A per-basis TALLY — {usd, count, unknownCount} — is one accounting
// shape instantiated twice, over different units, and the two instances are never added together.
// Both marker folds (the PR total in transport.js, the daily ledger in ledger.js) tally into this,
// so "how do you count a round whose figure is missing" is answered once for both.
// [LAW:no-silent-failure] A cost whose figure is absent raises unknownCount rather than vanishing,
// so each total is honestly reported as a lower bound (rendered with a '+') instead of a partial
// sum passed off as complete. A body with no marker at all (a pre-feature round) is a dollars-basis
// round of unknown cost — never a free one.
function emptyTallies() {
  return {
    billed: { usd: 0, count: 0, unknownCount: 0 },
    notional: { usd: 0, count: 0, unknownCount: 0 },
  };
}

function tallyCost(tallies, cost) {
  const basis = basisOf(cost);
  const tally = tallies[basis.bucket];
  const figure = basis.figure(cost);
  if (Number.isFinite(figure)) {
    tally.usd += figure;
    tally.count++;
  } else {
    tally.unknownCount++;
  }
  return tallies;
}

function tallyRounds(tally) {
  return tally.count + tally.unknownCount;
}

// [LAW:effects-at-boundaries] Pure: render one basis's running total, or null when that basis saw no
// rounds — so a PR that only ever ran on dollars renders exactly one clause, byte-identical to before
// this feature existed, and a PR that only ever ran on the subscription renders exactly one too.
function renderTally(label, tally) {
  const rounds = tallyRounds(tally);
  if (rounds === 0) return null;
  const approx = tally.unknownCount > 0 ? '+' : '';
  const note = tally.unknownCount > 0 ? `, ${tally.unknownCount} with unknown cost` : '';
  return `PR ${label} $${tally.usd.toFixed(4)}${approx} across ${rounds} rounds${note}`;
}

// [LAW:effects-at-boundaries] Pure: the " · PR total ..." clause appended to the cost line, or '' when
// there are no prior rounds (the first review — its single-round line stands alone, unchanged). The
// clause is a VALUE keyed on the prior-round count, not a second footer format.
// The two bases are rendered SIDE BY SIDE and never added: a PR whose early rounds ran on a paid API
// and whose later rounds ran on the subscription reports "$1.20 across 2 rounds · $40.00 list price
// across 2 subscription rounds", not a meaningless $41.20.
function renderPrTotal(thisCost, priorCost) {
  if (!priorCost) return '';
  const priorRounds = tallyRounds(priorCost.billed) + tallyRounds(priorCost.notional);
  if (priorRounds === 0) return '';
  const totals = tallyCost(
    {
      billed: { ...priorCost.billed },
      notional: { ...priorCost.notional },
    },
    thisCost,
  );
  const clauses = [
    renderTally('total', totals.billed),
    renderTally('list-price total', totals.notional),
  ].filter(Boolean);
  return clauses.length === 0 ? '' : ` · ${clauses.join(' · ')}`;
}

// [LAW:dataflow-not-control-flow] The basis selects a PHRASE; every cost line is then assembled by
// the same expression. There is no arm that renders a different line shape.
// [FRAMING:representation] Every figure this action renders is an ESTIMATE, never a billed charge: a
// table-priced provider (codex, deepseek, z.ai) is price-table × tokens; a genuine Anthropic run is
// Claude Code's own client-side total_cost_usd. So every priced line is marked "est.".
// The subscription phrase leads with what is TRUE — the review was not billed — and then reports the
// list price as the separate, clearly-labelled thing it is. That figure is the deliverable, not the
// hazard: it is how "is the subscription cheaper than the API bill, and how much of the plan am I
// using?" gets answered. It is emitted everywhere a cost is emitted, and summed into nothing.
const COST_PHRASE = {
  dollars: c => `Cost: $${c.usd.toFixed(4)}`,
  subscription: c => Number.isFinite(c.notionalUsd)
    ? `Not billed (Claude subscription) · $${c.notionalUsd.toFixed(4)} at Anthropic list price`
    : 'Not billed (Claude subscription) · list price not reported',
  unpriced: () => 'Cost: unknown',
};

// 'est.' qualifies a figure, so it rides with the bases that HAVE one. An unpriced line has nothing
// to qualify, and its absence of the marker is the pre-existing behavior, preserved.
const COST_IS_ESTIMATE = { dollars: true, subscription: true, unpriced: false };

// [LAW:effects-at-boundaries] Pure: render the cost footer line from a Usage value, or '' when
// there is no usage to report. The "loud" warning for missing usage/price is an effect and belongs
// at the run boundary (src/run.js); costWarning below produces its text, also purely.
// [LAW:dataflow-not-control-flow] usage === null and each cost basis are distinct VALUES with
// distinct renderings, not branches that skip work: no usage -> no line; every basis -> one line
// assembled by the same expression, differing only in the phrase its basis selected.
function renderCostLine(usage, config, priorCost = null) {
  if (!usage) return '';
  const tag = reviewerTag(config);
  const tokens = `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out tokens`;
  const prTotal = renderPrTotal(usage.cost, priorCost);
  const estimate = COST_IS_ESTIMATE[usage.cost.basis] ? ' · est.' : '';
  return `_${COST_PHRASE[usage.cost.basis](usage.cost)} · ${tokens} · ${tag}${estimate}${prTotal}_`;
}

// [LAW:effects-at-boundaries] Pure: the text of the "cost unavailable" warning, or null when cost
// is fully reported. [LAW:no-silent-failure] the message names the ACTUAL cause, dispatched on the
// basis and reason VALUES the adapter carried — never re-derived by branching on engine at the
// boundary. This is why they live in usage.cost: run.js stays ignorant of which engines are
// table-priced. A subscription run whose notional is missing still warns: its SPEND is known to be
// zero either way, but losing the list price loses the one number that judges the subscription.
const COST_WARNING = {
  dollars: () => null,
  subscription: (cost, tag, config) => Number.isFinite(cost.notionalUsd) ? null
    : `${config.engine} reported no cost for ${tag}; this review was billed to Claude subscription `
      + 'quota (so it cost $0 either way), but its Anthropic list-price figure is unavailable.',
  unpriced: (cost, tag, config) => cost.reason === 'no-price'
    ? `No price-table entry for ${tag}; the review footer shows cost as "unknown". `
      + 'Add the model to PRICES_PER_MILLION in src/usage.js.'
    : `${config.engine} reported no cost (no USD in its output) for ${tag}; `
      + 'the review footer shows cost as "unknown".',
};

function costWarning(usage, config) {
  if (!usage) return 'Engine reported no token usage; the review footer omits the cost line.';
  return COST_WARNING[usage.cost.basis](usage.cost, reviewerTag(config), config);
}

module.exports = {
  PRICES_PER_MILLION,
  computeCostUsd,
  renderCostLine,
  renderPrTotal,
  costMarker,
  parseCostMarker,
  parseCost,
  sumCost,
  emptyTallies,
  tallyCost,
  costWarning,
  formatTokenCount,
  isAnthropicEndpoint,
  isSubscription,
};
