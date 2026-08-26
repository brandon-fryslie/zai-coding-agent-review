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

// [LAW:types-are-the-program] THE TOKEN RECORD — the PRIMARY FACT behind every cost figure, and the
// one shape every adapter parses its vendor's raw counts into:
//
//   { inputCacheMiss, inputCacheHit, output }
//
// The three classes are DISJOINT — one billing rate each, summing to the run's whole token count —
// because that is the only shape a cost can be re-derived from later. The predecessor carried a
// COLLAPSED input total plus its cached SUBSET, which is why this function used to open with
// `Math.max(0, inputTokens - cachedInputTokens)`: an overlapping pair admits `cached > total`, so
// every consumer had to subtract and clamp. Disjoint classes delete that question rather than
// guarding it, and the price is then a plain dot product of three counts against three rates.
//
// Why it matters beyond tidiness: the two input rates differ by up to ~30x, and reviews run ~92%
// cache-hit. DeepSeek's real rates as of 2026-08-16 are miss $0.66/M and hit $0.022/M off-peak —
// figures quoted here as the MOTIVE for the split, NOT as what PRICES_PER_MILLION holds. That table
// is still the stale 2026-07-10 row and correcting it is zai-cost-truth-p5o.1's job, deliberately
// separate: recording a repriceable fact and repricing from a correct table are two changes, and
// landing them together would leave no way to tell a bad record from a bad rate. What this record
// buys is precisely that the correction can be applied RETROACTIVELY when it lands. A fused total
// cannot be — auditing PR #108 had to BORROW a cache-hit ratio measured from an unrelated local run
// to restate CI costs at all. [FRAMING:representation]
// the stored figure must be able to answer the question later, not merely print a number today; a
// cost is DERIVED, the tokens are primary, and the primary fact is what must be durable.
function totalInputTokens(tokens) {
  return tokens.inputCacheMiss + tokens.inputCacheHit;
}

function emptyTokens() {
  return { inputCacheMiss: 0, inputCacheHit: 0, output: 0 };
}

function addTokens(a, b) {
  return {
    inputCacheMiss: a.inputCacheMiss + b.inputCacheMiss,
    inputCacheHit: a.inputCacheHit + b.inputCacheHit,
    output: a.output + b.output,
  };
}

// [LAW:effects-at-boundaries] Pure: tokens + model -> USD, no IO. Returns null (cost unknown)
// when the model has no price-table entry — never a fabricated zero, so a missing price surfaces
// as "unknown" rather than a confident-but-wrong $0.00. [LAW:no-silent-failure]
// One rate per class, no subtraction: each adapter has already parsed its vendor's overlapping
// counts into the disjoint record above (see THE TOKEN RECORD), so by the time tokens arrive here
// the classes are exactly the billing buckets.
function computeCostUsd(tokens, model) {
  const price = PRICES_PER_MILLION[model];
  if (!price) return null;
  const total =
    tokens.inputCacheMiss * price.input +
    tokens.inputCacheHit * price.cachedInput +
    tokens.output * price.output;
  const usd = total / 1_000_000;
  // [LAW:types-are-the-program] Non-finite input (a NaN token count) yields no usable price, not a NaN
  // "cost": return null so the caller renders it unavailable, keeping a finite figure on every
  // dollars-basis cost.
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
// [LAW:one-source-of-truth] ONE extraction of "which host does this config's money go to", read by
// both consumers below. Two `new URL(baseUrl).hostname` sites would be two clocks: the billing-basis
// whitelist and the recorded provider identity would eventually disagree about what host a config
// points at, and the disagreement would show up as a review attributed to one vendor and priced as
// another. Returns null for an absent or unparseable base URL — a typed absence, not a guess.
function endpointHost(config) {
  const baseUrl = config.endpoint && config.endpoint.baseUrl;
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

function isAnthropicEndpoint(config) {
  // Every endpoint now carries a real baseUrl — an OAuth credential's is PINNED in the preset table
  // rather than absent — so this is a plain hostname whitelist with no special case for a missing URL
  // and none for a subscription. A pinned Anthropic host simply passes the same check every other
  // endpoint takes. [LAW:one-type-per-behavior]
  // [LAW:types-are-the-program] Match the anthropic.com domain exactly — the apex or a true
  // subdomain — never a bare `endsWith('anthropic.com')`, which a lookalike host like
  // `notanthropic.com` would satisfy and be wrongly trusted as Anthropic's billing basis.
  const host = endpointHost(config);
  return host === 'anthropic.com' || (host !== null && host.endsWith('.anthropic.com'));
}

// [LAW:one-source-of-truth] THE PROVIDER IDENTITY recorded with every cost: the endpoint HOST, which
// is a fact about where the money actually went rather than a label someone chose. That is exactly
// the property the ledger needs — `PROVIDER: auto` and `PROVIDER: deepseek` resolve to the same host
// and so record the same identity (they ARE the same money), while deepseek and z.ai record
// different ones. Deriving it from the resolved endpoint rather than from a name is also what makes
// it available in config-file mode, which has no PROVIDER input at all and where `config.name` is
// free text a consumer picked. A consumer who repoints a provider at a proxy records the proxy: that
// is not a defect, it is who was billed. [FRAMING:representation]
function providerIdentity(config) {
  return endpointHost(config);
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
// An unavailable or absent cost records a marker carrying NO figure field — the round is still
// counted, its cost just isn't summed. (The literal 'unknown' is the legacy spelling of that same
// state, still read below; the writer no longer emits it.)
// [LAW:types-are-the-program] The marker payload has exactly two forms, and BOTH are real data in
// the world — this is a widening, not a migration:
//
//   RECORD  {"usd":0.65,"tokens":{...},"model":"…","provider":"…","from":"…","to":"…"}
//   LEGACY  0.651731  |  unknown
//
// LEGACY is every marker posted before this feature. Those reviews are permanent — a PR's round
// count and running total are read back off its own history — so the legacy form is a first-class
// variant that parses into the same Cost value it always did, never an error and never a silent
// zero. [LAW:no-silent-failure] A past round whose cost is genuinely unknown must read as unknown.
//
// The legacy alternative stays a strict non-negative decimal (digits, one optional fractional part)
// or the literal 'unknown' — NOT a loose `[0-9.]+`, which would match '.', '1.2.3', or '123..456',
// all of which Number() turns into NaN. Cost is non-negative by construction, so no leading '-'; no
// exponent, so no Infinity.
//
// The RECORD alternative admits no '>' at all, which is what makes it safe to embed in an HTML
// comment: '-->' contains '>', so an encoded payload CANNOT terminate the comment early. That is a
// property of the grammar rather than a rule the writer must remember — see encodePayload.
// [LAW:one-source-of-truth] ONE value grammar, shared by both marker names below, so a marker that
// the notional reader accepts can never be one the spend reader would have rejected.
const MARKER_VALUE = '([0-9]+(?:\\.[0-9]+)?|unknown|\\{[^>]*\\})';

// [LAW:parse-dont-validate] The one crossing between a cost record and marker text, in both
// directions. Neither '>' nor a '--' pair can occur in JSON OUTSIDE a string literal, so replacing
// each with its six-character unicode escape is exact: it can only ever rewrite characters inside
// strings, and JSON.parse restores them byte-for-byte. Escaping beats rejecting a model id that
// contains one — a rejection would either crash a legitimate config or silently drop the record,
// and the payload is data we already own end to end.
//
// Two characters, two DIFFERENT hazards, and only the first is about breaking out:
//   '>'  — without it '-->' cannot be spelled, so an encoded payload cannot terminate its own
//          comment and leak the rest of the marker into the review body as visible text.
//   '--' — a comment terminator needs a '>', so a bare pair can never end the comment for OUR
//          reader. It is escaped because "the marker is INVISIBLE" is a claim about somebody
//          else's markdown renderer: CommonMark ≤0.29 forbade '--' inside a comment outright, and
//          while both hosts here render under the relaxed rule today, an invariant this module
//          asserts should not quietly depend on which revision a host happens to ship.
// [LAW:types-are-the-program] Cheaper to make the byte unrepresentable than to track a third
// party's parser version.
function encodePayload(record) {
  return JSON.stringify(record).replace(/>/g, '\\u003e').replace(/--/g, '-\\u002d');
}

// Returns null for a payload that is not a parseable record — a corrupted or hand-edited marker is
// read as "no figure recorded", the same as 'unknown', never as a crash on someone else's PR.
// [LAW:no-silent-failure] the round still counts; only its figure is unknown.
function decodePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// [LAW:types-are-the-program] THE SPEND EXCLUSION, MADE STRUCTURAL. A subscription review writes a
// DIFFERENTLY NAMED marker carrying a DIFFERENTLY NAMED figure field, so every spend reader —
// parseCostMarker here, sumCostToday in ledger.js, summarizePriorReviews in transport.js — has
// literally nothing to read on it: no `usd` under either name. The notional dollars are kept out of
// the daily spend by the shape, not by a guard someone must remember to write, and a future reader
// who adds a fourth spend fold inherits the exclusion for free.
//
// [LAW:one-source-of-truth] ONE table of what each basis IS, for accounting purposes: which marker
// name carries it, which tally bucket it lands in, and where its figure lives. A separate table per
// consumer could drift — a basis marked notional by the writer and billed by the tally would put
// notional dollars straight back into spend, which is the whole bug. One row, one answer.
// [LAW:dataflow-not-control-flow] The basis selects data (a name, a key, an accessor); the same
// render and the same fold then run for every basis. No arm skips writing a marker, so every review
// round stays countable — a subscription round is a round whose SPEND is known to be zero, not a
// missing one. An absent cost (no usage at all) is accounted as an unpriced one.
//
// `field` is the record key the figure is written under, and it carries THE SPEND EXCLUSION one
// level deeper than the marker name does: inside the payload the notional dollars are `notionalUsd`,
// so even a reader that decoded a record and went looking for `usd` finds nothing on a subscription
// round. Same discipline as the two marker names, applied to the two field names.
//
// THE AUTH KIND IS THIS COLUMN, NOT A FIELD. zai-billing-xl0.3 needs to bucket spend by auth method
// (api-key vs subscription), and the basis already answers it exactly: costFromEnvelope resolves
// `subscription` from, and only from, an oauth credential, so subscription ⟺ oauth and
// dollars|unpriced ⟺ api-key, with no third case. Storing an `auth` field beside the basis would be
// a second clock for one fact — free to drift, and the direction it drifts is a review attributed to
// the wrong payment method inside a total. [LAW:one-source-of-truth] Read it off the parsed basis.
//
// `toCost` is the read-side inverse of `figure`: a decoded figure (or null) back into the same
// discriminated Cost the writer held. It lives in the table for the reason every other column does —
// so "which basis is this" is answered once, and the answer carries everything that follows from it.
const BASIS = {
  dollars: {
    marker: 'agent-review-cost-usd', bucket: 'billed', field: 'usd', figure: c => c.usd,
    toCost: f => (f === null ? { basis: 'unpriced', reason: 'not-reported' } : { basis: 'dollars', usd: f }),
  },
  subscription: {
    marker: 'agent-review-notional-usd', bucket: 'notional', field: 'notionalUsd', figure: c => c.notionalUsd,
    toCost: f => ({ basis: 'subscription', notionalUsd: f }),
  },
  // A write-side-only row: unpriced shares the dollars marker NAME (that is what keeps an unpriced
  // round inside the spend accounting as a round of unknown cost), so a body never reads back to
  // here — the dollars row's toCost resolves a figureless dollars marker to exactly this basis.
  unpriced: {
    marker: 'agent-review-cost-usd', bucket: 'billed', field: 'usd', figure: () => null,
    toCost: f => BASIS.dollars.toCost(f),
  },
};

function basisOf(cost) {
  return BASIS[cost && cost.basis] || BASIS.unpriced;
}

// [LAW:one-source-of-truth] The reader's inverse of the writer's marker-name choice, derived from
// the same table rather than restated, so a name the writer emits is always a name the reader knows.
const BASIS_BY_MARKER = {
  [BASIS.dollars.marker]: BASIS.dollars,
  [BASIS.subscription.marker]: BASIS.subscription,
};

// [LAW:one-source-of-truth] Both marker names in ONE alternation, built from the BASIS table the
// writer picks them from — so the reader can never recognize a name the writer stopped emitting.
// One scan over both names is what makes the last-match rule hold ACROSS them: asking "is there a
// notional marker anywhere?" before looking at the spend marker reintroduced exactly the bug
// lastMatch exists to prevent — a dollars review whose prose quoted a notional marker was read as a
// subscription review, and its real spend silently left every fold. Position decides, not precedence.
const ANY_MARKER_RE = new RegExp(
  `<!-- (${BASIS.dollars.marker}|${BASIS.subscription.marker}):${MARKER_VALUE} -->`, 'g');

// [LAW:parse-dont-validate] THE COST RECORD — the crossing from a live run's values into the durable
// facts a marker carries, and the one place absence is recorded AS absence. A fact that was never
// observed (no usage at all; a config that names no model; an endpoint with no parseable host) is
// written as no field at all or as an explicit null — either way the reader recovers an absence, and
// never a zero. That distinction is the whole ticket: a figure of 0 asserts the review was free,
// while a missing figure asserts nothing and can still be restated later. [LAW:no-silent-failure]
//
// The figure is quantized to 6 decimal places, exactly as the legacy marker was, so the recorded
// dollars stay byte-stable across a re-render. It is NOT what a later audit reprices from — that is
// what `tokens` + `model` are for, at full precision — it is the figure this run believed at the
// time, kept so a restatement can be compared against it.
// [LAW:single-enforcer] The writer screens the figure through the SAME `recordedQuantity` the reader
// does, so what this function can emit is exactly what `parseCostRecord` will accept. A predicate
// applied on only one side is not one rule but two: the writer would emit a negative or non-finite
// figure that the reader then silently refuses, and the marker would round-trip to a DIFFERENT value
// than the one it was written from — a record that disagrees with itself is worse than no record.
// [LAW:types-are-the-program] So an unpriced cost, an unreported notional, a NaN from a broken
// upstream, and a nonsensical negative all reach the same honest end: no figure field at all.
function costRecord(usage, config) {
  const cost = usage && usage.cost;
  const basis = basisOf(cost);
  const figure = recordedQuantity(basis.figure(cost));
  const span = (usage && usage.span) || {};
  return {
    [basis.field]: figure === null ? undefined : Number(figure.toFixed(6)),
    tokens: usage ? usage.tokens : undefined,
    model: config.model,
    provider: providerIdentity(config),
    // The pass's time SPAN, not one instant. A review's spawns run over many minutes and time is
    // about to become a pricing input (DeepSeek's peak windows begin at 01:00/06:00 UTC), so a
    // single timestamp would silently misprice every review that straddles a boundary. Two ends let
    // a restatement price exactly when they fall in one window, and say so when they do not.
    from: span.from,
    to: span.to,
  };
}

function costMarker(usage, config) {
  return `<!-- ${basisOf(usage && usage.cost).marker}:${encodePayload(costRecord(usage, config))} -->`;
}

// [LAW:single-enforcer] ONE rule for which marker in a body is authoritative: the LAST one. It lives
// in the footer, after all summary/finding prose, so a review that QUOTES a marker in its prose (e.g.
// a review OF this feature) cannot hijack the reading. Every marker reader below scans through here,
// so none of them can hold a different opinion about which match wins.
function lastMatch(body, re) {
  if (typeof body !== 'string') return null; // not a marker-bearing body (human review, old review)
  const matches = [...body.matchAll(re)];
  return matches.length === 0 ? null : matches[matches.length - 1];
}

// [LAW:one-source-of-truth] ONE decoding from a captured payload to the facts every reader consumes.
// The two payload forms — a record, and the bare figure every marker posted before this feature
// carries — collapse to the SAME shape here, the legacy one simply carrying fewer facts. That is why
// no reader downstream asks which form it was handed: a legacy round is not a special case, it is a
// round whose tokens, model, provider and timing were never recorded. [LAW:dataflow-not-control-flow]
// An unparseable payload yields no facts at all, so a corrupted or hand-edited marker reads as an
// unknown-cost round rather than throwing on someone else's PR. [LAW:no-silent-failure]
function payloadFacts(raw, field) {
  if (raw.startsWith('{')) return decodePayload(raw) || {};
  const n = Number(raw); // 'unknown' -> NaN, and the strict grammar admits nothing else non-numeric
  return Number.isFinite(n) ? { [field]: n } : {};
}

// [LAW:parse-dont-validate] Facts arrive as decoded JSON, which is to say as `unknown` — a body can
// be hand-edited and a marker can be quoted from anywhere. Each accessor returns the fact or a typed
// absence, never a half-value: `tokens` in particular is all-three-or-nothing, because two of three
// classes cannot reprice anything and a partial record priced as if complete would understate the
// run, which is the failure this ticket exists to end.
function recordedString(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// [LAW:parse-dont-validate] A recorded quantity — dollars or a token count — is a NON-NEGATIVE finite
// number or nothing. The legacy grammar enforced this structurally: its value pattern admits no
// leading '-', so a negative figure could not be spelled. The record payload is JSON and could, so
// the sign check moves here rather than being lost in the widening. A hand-edited
// `{"usd":-999999}` would SUBTRACT from the PR total and the daily ledger — the one direction a
// corrupted marker must never be able to move a total, since under-counting spend is what releases a
// budget gate rather than tripping it. A negative here is not a smaller number, it is a differently
// signed claim, and it is rejected as unrecordable rather than tallied. [LAW:no-silent-failure]
function recordedQuantity(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function recordedTokens(v) {
  if (v === null || typeof v !== 'object') return null;
  const tokens = {
    inputCacheMiss: recordedQuantity(v.inputCacheMiss),
    inputCacheHit: recordedQuantity(v.inputCacheHit),
    output: recordedQuantity(v.output),
  };
  return Object.values(tokens).every(n => n !== null) ? tokens : null;
}

// [LAW:parse-dont-validate] THE ONE READER. Every marker consumer below is this function plus a
// projection, so a body one of them scores as unknown can never be a figure to another. Returns null
// for a body carrying no marker at all — a human review, or a round predating cost reporting.
function parseCostRecord(body) {
  const m = lastMatch(body, ANY_MARKER_RE);
  if (m === null) return null;
  const [, name, raw] = m;
  const basis = BASIS_BY_MARKER[name];
  const facts = payloadFacts(raw, basis.field);
  const figure = facts[basis.field];
  return {
    cost: basis.toCost(recordedQuantity(figure)),
    tokens: recordedTokens(facts.tokens),
    model: recordedString(facts.model),
    provider: recordedString(facts.provider),
    from: recordedString(facts.from),
    to: recordedString(facts.to),
  };
}

// Read a review body's marker back into the SAME Cost value costMarker wrote, so the two folds that
// consume markers (the daily ledger, the PR total) tally a typed value instead of each re-deciding
// what a raw marker string means.
function parseCost(body) {
  const record = parseCostRecord(body);
  return record === null ? null : record.cost;
}

// The spend reader: the dollars figure alone, 'unknown' when a spend-basis marker recorded none, and
// null when the body carries no spend marker at all. A subscription review is invisible to it by
// construction — its record lands on the notional basis, which has no `usd` — see THE SPEND
// EXCLUSION above.
function parseCostMarker(body) {
  const record = parseCostRecord(body);
  if (record === null || record.cost.basis === 'subscription') return null;
  return record.cost.basis === 'dollars' ? record.cost.usd : 'unknown';
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
  // The human line stays one clause per quantity: the input total a reader already expects, with the
  // cache-hit share named beside it in the SAME unit rather than as a derived percentage — an
  // absolute count has no undefined case at zero input and states the fact instead of a ratio of it.
  // The disjoint classes are the record's job (see THE TOKEN RECORD); this is a rendering of them.
  const inputTokens = totalInputTokens(usage.tokens);
  const tokens = `${formatTokenCount(inputTokens)} in (${formatTokenCount(usage.tokens.inputCacheHit)} cached)`
    + ` / ${formatTokenCount(usage.tokens.output)} out tokens`;
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
  totalInputTokens,
  emptyTokens,
  addTokens,
  renderCostLine,
  renderPrTotal,
  costMarker,
  costRecord,
  parseCostMarker,
  parseCost,
  parseCostRecord,
  providerIdentity,
  sumCost,
  emptyTallies,
  tallyCost,
  costWarning,
  formatTokenCount,
  isAnthropicEndpoint,
  isSubscription,
};
