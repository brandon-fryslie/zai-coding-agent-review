'use strict';

// Per-run token/cost reporting.
//
// [LAW:decomposition] Two cohesive concerns live here: the price table (a representation that
// drifts from each provider's real prices and must be hand-maintained) and the pure renderer that
// formats an already-extracted Usage value into the review footer line. Extraction is engine-specific
// and lives in each adapter (engine/codex.js, engine/claude-code.js); this module computes cost from
// tokens × price and formats the footer.
// [LAW:single-enforcer] Token cost is computed in exactly one place: priceFromTable.

// [LAW:types-are-the-program] A PRICE ENTRY IS A RATE SCHEDULE, not a rate:
//
//   { tiers: [ { when: Constraint[], rates: {input, cachedInput, output} } ] }
//
// The FIRST tier whose every constraint holds wins, and `when: []` holds always — so a flat-rate
// vendor is one tier constraining nothing, never a second union arm, and ratesAt runs the identical
// operations for every model with the variability living entirely in the data.
// [LAW:dataflow-not-control-flow] [LAW:no-mode-explosion] This is why there is no isDeepSeek flag, no
// isPeak boolean and no isLongContext boolean anywhere below.
//
// A CONSTRAINT NAMES ITS AXIS, and a rate is therefore selected by a VECTOR of facts about the spawn
// — when it ran AND how long its prompts were — rather than by an instant alone. Each axis has one
// matcher (CONSTRAINT_MATCHERS), so the next vendor to price along a new axis is a new constraint kind
// plus its matcher, and NOT an edit to any row that does not use it. [LAW:locality-or-seam] An axis
// with no matcher THROWS rather than silently holding: a constraint nobody can evaluate that reads as
// "satisfied" would price the spawn off the wrong rate card. [LAW:no-silent-failure]
//
// THERE IS DELIBERATELY NO ALWAYS-PRESENT `rates` FIELD, and its removal is the point rather than a
// side effect. The previous shape carried a STANDARD rate beside the tiers, on the theorem that "a
// schedule with a moment it cannot price is unrepresentable — there is no gap to fall into". That
// theorem is TRUE of time (a vendor charges something at every instant) and FALSE of context length,
// which is how it was discovered: OpenAI publishes gpt-5.5 as "gpt-5.5 (<272K context length)" and
// publishes no rate at all above that, while the model's own context window is 1,050,000 — so the
// unpriced region is reachable, not hypothetical. A standard-rate field would have forced that gap to
// be spelled as a rate, i.e. to assert the ≤272K price applies at 900K. A stronger-but-false theorem
// makes the code lie; the honest one is that a schedule MAY decline, and a spawn no tier covers is
// reported unpriced and loud. [FRAMING:representation] [LAW:no-silent-failure]
//
// DeepSeek's peak window, quoted from the official pricing page: "Peak hours are
// 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday". WHEN that was last confirmed is not
// written here — it is the DeepSeek source's `verifiedOn` below, which covers this window exactly as
// it covers the rates. A date restated in a comment beside the field that owns it is the second clock
// this table was just rid of. [LAW:one-source-of-truth]
// The DAYS are as load-bearing as the hours and are why peak is two constraints rather than an hours
// list: peak covers 7 hours on 5 days, so a schedule holding only the hours would bill every weekend
// review at double its real rate — the same silently-wrong figure this epic exists to end, in the
// opposite direction. [FRAMING:representation]
const DEEPSEEK_PEAK = [
  { axis: 'daysUtc', days: [1, 2, 3, 4, 5] },
  { axis: 'hoursUtc', ranges: [[1, 4], [6, 10]] },
];

// OpenAI's context split, quoted from the tooltips on its own pricing table: short context is
// "≤272K input tokens", long context is ">272K input tokens". ONE constant carries the boundary and
// both constraints derive from it, so the two halves cannot drift into overlapping or leaving a gap.
// [LAW:one-source-of-truth] Half-open [start, end) exactly as the hour windows are, which is why the
// boundary is written as the first LONG token count rather than the last short one: token counts are
// integers, so "≤272,000" and "[0, 272,001)" are the same set, and one convention for every axis beats
// a second inclusive-end rule that only this axis would use. [LAW:one-type-per-behavior]
const OPENAI_LONG_CONTEXT_FROM = 272_001;
const SHORT_CONTEXT = { axis: 'contextTokens', range: [0, OPENAI_LONG_CONTEXT_FROM] };
const LONG_CONTEXT = { axis: 'contextTokens', range: [OPENAI_LONG_CONTEXT_FROM, Infinity] };

// [LAW:one-source-of-truth] EVERY priced provider, one table — grouped by the PAGE a human verifies it
// against, because that page and the date someone last read it are facts ABOUT these rates and not
// commentary beside them. They used to be exactly that: a "Sources / last verified" block comment
// above the table, which is a map only a human redraws. It went stale on 2026-08-16 and stayed stale
// for six weeks while every review printed a confident figure understating the real bill ~3.6x, and
// nothing in the system could even ask how old the numbers were. A date the machine can read is a date
// a check can refuse (see stalePriceSources below and scripts/check-price-freshness.js).
// [FRAMING:representation]
//
// The grouping is what makes "priced but unverified" unrepresentable: a model lives INSIDE the source
// that dates it, so a rate cannot be added without a page and a date, and re-verifying a vendor is one
// edit rather than one-per-row that must agree. `verifiedOn` covers the WHOLE schedule the group
// holds — every rate, every tier, and every tier's window and days — so a vendor that moves a peak
// boundary or drops a weekday drifts exactly as detectably as one that changes a number.
//
// PRICE-SENSITIVE and hand-maintained: there is no machine source, and building a scraper against a
// marketing page would be a second map with no contract. Re-verifying means opening `url`, comparing
// every figure AND every window below, and moving `verifiedOn` to the day you did it.
// Dollars per ONE MILLION tokens, matching each vendor's published per-1M figures so a reader can
// eyeball them against the page. `cachedInput` is the discounted prompt-cache rate.
const PRICE_SOURCES = [
  {
    vendor: 'OpenAI',
    // The DEVELOPER pricing page, not openai.com/api/pricing — that host answers 403 to a plain
    // fetch, and this one renders the same figures in a table a human can read end to end.
    url: 'https://developers.openai.com/api/docs/pricing',
    verifiedOn: '2026-08-27',
    // WHAT the last reconciliation found, recorded here because the date alone cannot carry it — when
    // it happened is `verifiedOn` above and is never restated in prose, or this group would keep two
    // clocks about its own freshness. [FRAMING:representation]
    //
    // Every row below was read off this page's own tables on that date, including the three that a
    // previous pass recorded as unfindable. They ARE here — the flagship table carries
    // gpt-5.6-{sol,terra,luna} and the "all models" table carries the rest — so the blind spot that
    // pass recorded ("no page we can name prices these rows") is RESOLVED, not inherited. What misled
    // it is worth naming, because the next reader will meet it too: the all-models table renders from
    // a JSON payload in the page source rather than as static markup, so a reader who searches only
    // the rendered text finds gpt-5.6 and concludes the older rows are gone.
    //
    // THE SPLIT IS THE POINT OF THIS GROUP. The page prices by CONTEXT LENGTH, its own column tooltips
    // defining short as "≤272K input tokens" and long as ">272K input tokens":
    //   - gpt-5.6-{sol,terra,luna} publish BOTH cards, so both are carried.
    //   - gpt-5.5 and gpt-5.4 are listed as "gpt-5.5 (<272K context length)" and publish NO card above
    //     that. Their schedules therefore stop at 272K and a larger spawn is reported unpriced. This
    //     is a real gap and not a transcription slip: both models carry a 1,050,000 context window
    //     (developers.openai.com/api/docs/models/gpt-5.5), so a >272K request is accepted by the model
    //     while the vendor names no price for it. Carrying these as flat rates — which is what this
    //     table did until now — asserted the ≤272K price applies at 900K. [LAW:no-silent-failure]
    //   - gpt-5.4-mini is listed with NO context qualifier and one card, so it is genuinely flat and
    //     its tier constrains nothing. The distinction is the vendor's, not ours.
    //
    // OpenAI also publishes a FOURTH class, "cache writes" ($5.00 for sol against $4.00 input). THE
    // TOKEN RECORD folds cache creation into the cache-MISS class, which is exact for DeepSeek and
    // Anthropic (both bill it at the full input rate) and approximate here. It costs nothing today
    // because codex reports no cache-write count to price — its usage payload carries input_tokens,
    // cached_input_tokens and output_tokens only — so there is no number being multiplied by the wrong
    // rate, and inventing one to fill the class would be a guess wearing a number.
    models: {
      'gpt-5.6-sol': {
        tiers: [
          { when: [SHORT_CONTEXT], rates: { input: 4.00, cachedInput: 0.40, output: 20.00 } },
          { when: [LONG_CONTEXT], rates: { input: 8.00, cachedInput: 0.80, output: 30.00 } },
        ],
      },
      'gpt-5.6-terra': {
        tiers: [
          { when: [SHORT_CONTEXT], rates: { input: 2.00, cachedInput: 0.20, output: 12.00 } },
          { when: [LONG_CONTEXT], rates: { input: 4.00, cachedInput: 0.40, output: 18.00 } },
        ],
      },
      'gpt-5.6-luna': {
        tiers: [
          { when: [SHORT_CONTEXT], rates: { input: 0.20, cachedInput: 0.02, output: 1.20 } },
          { when: [LONG_CONTEXT], rates: { input: 0.40, cachedInput: 0.04, output: 1.80 } },
        ],
      },
      'gpt-5.5': {
        tiers: [{ when: [SHORT_CONTEXT], rates: { input: 5.00, cachedInput: 0.50, output: 30.00 } }],
      },
      'gpt-5.4': {
        tiers: [{ when: [SHORT_CONTEXT], rates: { input: 2.50, cachedInput: 0.25, output: 15.00 } }],
      },
      'gpt-5.4-mini': {
        tiers: [{ when: [], rates: { input: 0.75, cachedInput: 0.075, output: 4.50 } }],
      },
    },
  },
  {
    vendor: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/quick_start/pricing',
    verifiedOn: '2026-08-26',
    // Peak/off-peak took effect 16:00 UTC 2026-08-16 per https://api-docs.deepseek.com/news/news260813;
    // cross-checked against https://www.aipricing.guru/deepseek-pricing/ and
    // https://tokencost.app/models/deepseek-v4-pro. DeepSeek's standard rate is its OFF-PEAK rate;
    // peak is exactly double across all three classes today. The peak numbers are written out rather
    // than expressed as a 2x multiplier because what the vendor publishes is two rate cards, and a
    // multiplier would make the table a claim about the RELATIONSHIP between them — one that stops
    // being true the first time a vendor prices its classes independently, and one no reader could
    // check against the pricing page. [FRAMING:representation]
    // The tiny cachedInput rates are DeepSeek's real published disk-cache pricing — a cache hit is
    // priced ~30x below a cache miss — an intentional outlier, not typos.
    models: {
      'deepseek-v4-pro': {
        tiers: [
          { when: DEEPSEEK_PEAK, rates: { input: 1.32, cachedInput: 0.044, output: 3.96 } },
          { when: [], rates: { input: 0.66, cachedInput: 0.022, output: 1.98 } },
        ],
      },
      'deepseek-v4-flash': {
        tiers: [
          { when: DEEPSEEK_PEAK, rates: { input: 0.44, cachedInput: 0.014, output: 1.32 } },
          { when: [], rates: { input: 0.22, cachedInput: 0.007, output: 0.66 } },
        ],
      },
    },
  },
  {
    vendor: 'z.ai GLM',
    url: 'https://docs.z.ai/guides/overview/pricing',
    // Read straight off the page, every row: both were unchanged, and the page advertises no
    // time-of-day tier. (When that happened is `verifiedOn`, never restated here.)
    verifiedOn: '2026-08-26',
    models: {
      'glm-5.1': { tiers: [{ when: [], rates: { input: 1.40, cachedInput: 0.26, output: 4.40 } }] },
      'glm-4.6': { tiers: [{ when: [], rates: { input: 0.60, cachedInput: 0.11, output: 2.20 } }] },
    },
  },
];

// [LAW:one-source-of-truth] The flat lookup every price call indexes, DERIVED from the grouped table
// rather than maintained beside it, keyed by the exact model id each engine reports (namespaces don't
// collide: gpt-*, deepseek-*, glm-*).
//
// The table has a NULL PROTOTYPE, and that is load-bearing rather than tidy. A model id is a config
// value, so it can be any string; an ordinary object answers `constructor` or `toString` with
// Object.prototype's members, handing the lookup something truthy that is not a rate schedule, which
// then reads `.tiers` off a function and throws mid-review. Refusing the members at construction is
// one enforcer at the one place the table is built, so every reader gets `undefined` for a model that
// is not listed and no reader has to remember an own-key guard. [LAW:types-are-the-program]
//
// A model listed under two vendors throws HERE rather than letting the later silently win: two groups
// claiming one model id are two rate schedules for one fact, and which one priced your review would
// then depend on array order. [LAW:no-silent-failure]
function flattenPrices(sources) {
  const table = Object.create(null);
  for (const source of sources) {
    for (const [model, entry] of Object.entries(source.models)) {
      if (model in table) {
        throw new Error(`price table lists ${model} under two sources (${source.vendor} repeats it); one model, one rate schedule`);
      }
      table[model] = entry;
    }
  }
  return table;
}

const PRICES_PER_MILLION = flattenPrices(PRICE_SOURCES);

const MS_PER_DAY = 86_400_000;

// How long a hand-copied rate may go unconfirmed before the build refuses it. Thirty days is a legible
// human cadence (open three pricing pages once a month) and it is the number the incident argues for:
// DeepSeek repriced 37 days after this table's last verification and the wrong figures ran for six
// more weeks. A threshold cannot make drift impossible — nothing can, for a map with no machine source
// — it can only BOUND how long the drift stays silent, and the bound has to be shorter than the
// interval that already burned us. One threshold for every vendor, not one per row: a rate nobody is
// paying today is a wrong figure the moment someone flips PROVIDER, and a per-source knob would be a
// mode with no owner. [LAW:no-mode-explosion]
const PRICE_VERIFICATION_MAX_AGE_DAYS = 30;

// [LAW:parse-dont-validate] A verification date is written 'YYYY-MM-DD' and read as UTC midnight. It
// throws on anything else, because the alternative is the quietest possible failure: an unreadable
// date yields a NaN age, NaN compares false against every threshold, and that source would be scored
// FRESH forever. A typo that silently disables the staleness check is this ticket's own bug wearing
// its fix as a costume. [LAW:no-silent-failure]
function verifiedOnMs(source) {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(source.verifiedOn)
    ? Date.parse(`${source.verifiedOn}T00:00:00Z`)
    : NaN;
  if (!Number.isFinite(ms)) {
    throw new TypeError(`price source ${source.vendor} has an unreadable verifiedOn: ${String(source.verifiedOn)}`);
  }
  return ms;
}

// [LAW:effects-at-boundaries] Pure: which of these price sources are overdue for re-verification, as
// of an instant the caller supplies. No clock read, so a test names the instant and the answer is
// deterministic; the one clock read lives in scripts/check-price-freshness.js, the boundary that acts
// on the answer.
//
// [LAW:single-enforcer] THE one predicate for "has this table gone stale", so the CI check cannot hold
// a different opinion than a test does. Sources arrive as an argument rather than being reached for,
// so the shipped table is one INPUT to this rule and never a hidden dependency a caller must
// neutralize to test it.
//
// Each returned source carries its age AND the REASON it is not fresh, because those are two
// different problems with two different remedies and only the code that computed the age knows which
// one it found. A reporter left to re-derive it from `ageDays < 0` would be a second opinion about
// what the number means — and the two drift the first time this threshold gains a nuance, at which
// point the report starts describing the wrong defect. [LAW:types-are-the-program]
function stalePriceSources(sources, at, maxAgeDays = PRICE_VERIFICATION_MAX_AGE_DAYS) {
  const now = instantMs(at, 'price-table freshness needs the current instant as a Date');
  return sources
    .map((source) => {
      const ageDays = Math.floor((now - verifiedOnMs(source)) / MS_PER_DAY);
      return { source, ageDays, reason: stalenessOf(ageDays, maxAgeDays) };
    })
    .filter(entry => entry.reason !== null);
}

// Freshness is a bounded interval [0, maxAgeDays] rather than a one-sided "not too old", so the two
// ways a date can fail are named rather than merged. `overdue` is the ordinary case. `future-dated` is
// a typo or a date bumped without opening the page, and folding it into "overdue" would report a
// source as under-verified when the real fault is a date ahead of the clock — the opposite defect,
// with an age that renders as "-30 days ago". Left un-checked entirely it is worse than a bad message:
// a future date is younger than every threshold, so it reads as permanently fresh and silences this
// check for good. [LAW:no-silent-failure]
// Ages are whole elapsed days, floored, so the boundary is exact: at maxAgeDays a source is still
// fresh, at maxAgeDays + 1 it is not. `null` is the fresh arm — a typed absence, not a third reason.
function stalenessOf(ageDays, maxAgeDays) {
  if (ageDays < 0) return 'future-dated';
  if (ageDays > maxAgeDays) return 'overdue';
  return null;
}

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
// cache-hit, so the class this workload leans on hardest is the one DeepSeek's 2026-08-16 repricing
// moved hardest — +507% at the off-peak rate and +1114% at the peak one (0.003625 -> 0.022 / 0.044),
// against ~52% for the miss class. This record is what let that correction land RETROACTIVELY: every
// review posted from 1.53.0 on records its own disjoint counts, its model and its span. A pass whose
// recorded span falls wholly inside one rate window reprices EXACTLY from those facts; one that
// straddles a window boundary reprices to a range, because the marker holds the pass ENVELOPE and
// not each spawn's own instant (see priceFromTable). A fused total cannot be repriced — auditing PR #108
// had to BORROW a cache-hit ratio measured from an unrelated local run to restate CI costs at all.
// Reviews posted BEFORE 1.53.0 carry a bare figure and are a permanent, honest gap: they must be
// restated as unknown, never quietly repriced as if their tokens had been recorded.
// [FRAMING:representation]
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

// [LAW:single-enforcer] ONE spelling of "a clock value is a real Date or it is an error", shared by
// both readers of one below — the rate lookup above and the freshness check further down. `what` is
// the caller's own sentence rather than a generic message, because the two failures need different
// remedies: a missing spawn instant is a threading bug in the adapter seam, an unreadable `now` is a
// bug in the check's own boundary.
function instantMs(at, what) {
  const ms = at instanceof Date ? at.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${what}; got ${String(at)}`);
  return ms;
}

// [LAW:single-enforcer] ONE matcher per pricing axis, and the only place an axis's meaning is decided.
// Every matcher answers the same question — "do the spawn's facts PROVE this constraint holds?" — so
// a fact that is merely consistent with a constraint does not satisfy it. That distinction is what
// makes the context axis sound; see SPAWN FACTS below.
//
// Half-open [start, end) on every range axis: a boundary value belongs to the window that STARTS
// there, never the one that ends there, so two adjacent windows can neither both claim it nor leave it
// unclaimed. [LAW:one-type-per-behavior]
const CONSTRAINT_MATCHERS = {
  daysUtc: (constraint, facts) => constraint.days.includes(facts.day),
  hoursUtc: (constraint, facts) => constraint.ranges.some(([start, end]) => facts.hour >= start && facts.hour < end),
  // The fact is an INTERVAL the true context length lies within, so the constraint holds only when the
  // WHOLE interval falls inside the window — "every value it could be is priced at this card". A
  // spawn whose interval straddles the boundary proves nothing and matches neither side.
  contextTokens: (constraint, facts) => facts.context.min >= constraint.range[0]
    && facts.context.max < constraint.range[1],
};

// [LAW:dataflow-not-control-flow] Rate selection with no branch on WHICH axes a model prices along:
// the first tier whose every constraint holds wins, and a tier constraining nothing holds always, so
// a flat model, a time-tiered one and a context-tiered one take the identical path.
//
// Returns null when NO tier covers the spawn — the schedule declining, which is a real state now that
// entries may carry a gap (see the OpenAI group). An unknown axis throws instead: a constraint nobody
// can evaluate is a table someone edited without teaching the matcher, and reading it as "holds" would
// price the spawn off whichever card happened to be listed first. [LAW:no-silent-failure]
function ratesAt(entry, facts) {
  const tier = entry.tiers.find((t) => t.when.every((constraint) => {
    const matcher = CONSTRAINT_MATCHERS[constraint.axis];
    if (!matcher) throw new Error(`price table constrains unknown axis "${constraint.axis}"; add a matcher to CONSTRAINT_MATCHERS`);
    return matcher(constraint, facts);
  }));
  return tier ? tier.rates : null;
}

// [LAW:parse-dont-validate] THE SPAWN: everything a price depends on, in one value — the tokens spent,
// when they started being spent, and what is known about the context length they were spent at. It is
// an explicit ARGUMENT rather than something priceFromTable derives, because this vector IS the seam:
// different callers know different amounts about a spawn, and a derivation hidden inside would fix
// every caller at whatever the least-informed one can prove. [LAW:dataflow-not-control-flow]
//
// `context` is an INTERVAL, not a number, and that is the whole honesty of this axis. OpenAI bills
// context length PER REQUEST, while THE TOKEN RECORD counts a SUM over every request in the spawn:
// measured against a real codex run on 2026-08-27, one turn making three model requests of ~26K
// context each reported input_tokens 78,338 — three times the context, not the context. Feeding that
// sum to a ">272K" test would price a four-request spawn of 70K prompts at the long-context card and
// double its bill, which is precisely the confident misprice this epic exists to end.
//
// spawnFromTokens is what an engine adapter can honestly claim TODAY, and it is one function rather
// than a line in each adapter so the two cannot come to different opinions about what a token total
// proves. [LAW:one-source-of-truth] What the sum proves is an upper bound — no single request's
// context exceeded the total — so the interval is [0, total]: a spawn totalling under 272K is PROVABLY
// short and prices correctly, while a larger one proves neither card and is reported unpriced rather
// than guessed. An adapter that can one day observe a per-request context builds a narrower interval
// and the long card becomes reachable with no change to any of this. [FRAMING:representation]
function spawnFromTokens(at, tokens) {
  return { at, tokens, context: { min: 0, max: totalInputTokens(tokens) } };
}

// The coordinates a constraint is matched against, parsed from the spawn once per price lookup. The
// instant's loud arm is the point: an Invalid Date (or an omitted argument JS quietly turns into one)
// yields NaN coordinates, NaN falls in no window, and the spawn would read as an unpriceable gap —
// a caller's threading bug wearing the costume of a vendor's pricing gap. [LAW:no-silent-failure]
// Fractional hours (not whole ones) because a vendor is free to move a boundary to :30 — the
// coordinate should not decide what the schedule is allowed to express.
function spawnFacts(spawn) {
  instantMs(spawn.at, "price lookup needs the spawn's start instant as a Date");
  return {
    day: spawn.at.getUTCDay(),
    hour: spawn.at.getUTCHours() + spawn.at.getUTCMinutes() / 60,
    context: contextInterval(spawn.context),
  };
}

// The context interval is established HERE, beside the instant, because this function is the spawn's
// parse boundary and a boundary that establishes one of its two facts is not a boundary. Passing
// `context` through unparsed made a caller's threading bug MODEL-DEPENDENT: a hand-rolled
// `{at, tokens}` priced cleanly against every flat or time-tiered model, whose tiers never consult
// the axis, and only detonated against a context-tiered one — so the identical defect was invisible
// in most of the table and fatal in one corner of it. That asymmetry is precisely what `instantMs`
// throws to prevent, and it is worth no less on the sibling field. [LAW:parse-dont-validate]
//
// What this establishes is that the interval is PRESENT, never that it is priceable. Those are two
// different facts and only the first is a caller's bug: a spawn whose bounds are non-finite because
// its TOKEN COUNTS were is a real domain value, and the schedule already answers it correctly —
// no tier's range can contain a NaN, so it falls through to `schedule-gap`, which is exactly what a
// spawn nothing can price should report. Throwing there would turn an honest "this cannot be priced"
// into a crash mid-review. `typeof` is the discriminator rather than Number.isFinite precisely
// because NaN IS a number: it arrived through the interval, whereas an absent bound never had one.
// [LAW:parse-dont-validate]
function contextInterval(context) {
  const { min, max } = context ?? {};
  if (typeof min !== 'number' || typeof max !== 'number') {
    throw new TypeError(
      "price lookup needs the spawn's context as a {min, max} token interval "
      + `(build it with spawnFromTokens); got ${JSON.stringify(context) ?? String(context)}`,
    );
  }
  return { min, max };
}

// [LAW:effects-at-boundaries] Pure: a spawn + a model -> a cost, with no IO and no clock read. The
// spawn's `at` is a REQUIRED value supplied by the boundary that owns the engine child's lifetime
// (src/engine/cli.js), because a rate that varies by time of day cannot be selected without it and
// reading the clock here would price a spawn at the moment its output was parsed rather than the
// moment it ran.
//
// Each SPAWN is priced at its own start, never the run at the run's start: a multi-scope pass runs
// for many minutes across many spawns and routinely straddles 04:00 UTC, so one rate for the whole
// pass would misprice every spawn on the far side of the boundary. The pass total is then the sum of
// individually-priced spawns (sumCost), never the sum repriced at one tier.
//
// The residual, stated rather than hidden: a single spawn that itself crosses a boundary is billed by
// the vendor per request across both tiers, and is priced here wholly at its start tier. Nothing in
// the engine's output reports when within the spawn each request fired, so any finer split would be a
// fabricated ratio — a guess wearing a number. Spawns run minutes and boundaries fall four times a
// day, so this is a bounded ~1% of spawns rather than the systematic ~3.6x understatement it replaces.
//
// [LAW:single-enforcer] Returns THE COST VALUE itself rather than a bare number, so the two ways a
// table price can be unavailable are NAMED once, here, where each is discovered — instead of every
// adapter collapsing them to null and re-deriving a single reason for all of them. Both adapters used
// to end with the identical `usd == null ? {reason:'no-price'} : {usd}`, which was already a second
// copy of that judgement and would have reported "add the model to PRICE_SOURCES" for a model that IS
// in PRICE_SOURCES. A remedy that sends the maintainer to do a thing that cannot help is the same
// misattribution as blaming a time budget for a quota wall. [LAW:no-silent-failure]
//
//   no-price     — no entry: the model is absent from the table entirely.
//   schedule-gap — an entry, but no tier covers this spawn: either the vendor prices no card for it
//                  (gpt-5.5 above 272K) or the spawn's facts cannot prove which card applies.
//
// One rate per class, no subtraction: each adapter has already parsed its vendor's overlapping counts
// into the disjoint record above (see THE TOKEN RECORD), so by the time tokens arrive here the classes
// are exactly the billing buckets.
function priceFromTable(spawn, model) {
  const { tokens } = spawn;
  const facts = spawnFacts(spawn);
  // A plain index is safe here only because the table is built with a null prototype (flattenPrices),
  // so a model id like `constructor` or `toString` reads as the absence it is instead of answering
  // with an inherited member that is not a rate schedule.
  const entry = PRICES_PER_MILLION[model];
  if (!entry) return { basis: 'unpriced', reason: 'no-price' };
  const price = ratesAt(entry, facts);
  if (!price) return { basis: 'unpriced', reason: 'schedule-gap' };
  const usd = (
    tokens.inputCacheMiss * price.input +
    tokens.inputCacheHit * price.cachedInput +
    tokens.output * price.output
  ) / 1_000_000;
  // [LAW:types-are-the-program] Non-finite input (a NaN token count) yields no usable price, not a NaN
  // "cost": report it unpriced so every dollars-basis figure stays finite. It reads as a schedule gap
  // because that is what it is — a spawn this schedule cannot answer for.
  return Number.isFinite(usd) ? { basis: 'dollars', usd } : { basis: 'unpriced', reason: 'schedule-gap' };
}

// [LAW:types-are-the-program] THE COST VALUE. A review's cost is discriminated by its BASIS — the
// question "was this paid in dollars at all?" — because a subscription run's figure is a real,
// exactly-known number that is nonetheless NOT spend:
//
//   { basis: 'dollars',      usd }                                 real money; the ONLY arm a spend fold reads
//   { basis: 'subscription', notionalUsd: number | null }          plan quota; Anthropic LIST PRICE, never spend
//   { basis: 'unpriced',     reason: 'no-price'|'schedule-gap'|'not-reported' }   dollars, but the figure is unrecoverable
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
// written as NO FIELD AT ALL — one spelling of absence, not two, since `recorded` collapses every
// reader-predicate null to an omitted key. The reader recovers an absence, never a zero. That distinction is the whole ticket: a figure of 0 asserts the review was free,
// while a missing figure asserts nothing and can still be restated later. [LAW:no-silent-failure]
//
// The figure is quantized to 6 decimal places, exactly as the legacy marker was, so the recorded
// dollars stay byte-stable across a re-render. It is NOT what a later audit reprices from — that is
// what `tokens` and `model` are for, at full precision, together with an INSTANT the auditor draws
// from the span, since `priceFromTable` selects a rate from one instant and never from two ends —
// which is also why a pass straddling a boundary reprices to a range rather than a figure. The
// recorded dollars are what this run believed at the time, kept so a restatement can be compared
// against it.
// [LAW:single-enforcer] EVERY field is screened through the SAME predicate its reader uses — the
// figure and each token class through `recordedQuantity`, each string fact through `recordedString`
// — so the set of records this function can emit IS the set `parseCostRecord` accepts. A predicate
// applied on one side only is not one rule but two: the writer emits something the reader silently
// refuses, and the marker round-trips to a DIFFERENT value than it was written from. A record that
// disagrees with itself is worse than no record. Screening only the figure was exactly that bug one
// field wide — a negative token count still went out to be rejected on the way back in.
// [LAW:types-are-the-program] So an unpriced cost, an unreported notional, a NaN from a broken
// upstream, a nonsensical negative, and a config naming no model all reach the same honest end: an
// absent field, which is what "not recorded" looks like.
function costRecord(usage, config) {
  const cost = usage && usage.cost;
  const basis = basisOf(cost);
  const figure = recordedQuantity(basis.figure(cost));
  const span = (usage && usage.span) || {};
  return {
    [basis.field]: recorded(figure === null ? null : Number(figure.toFixed(6))),
    tokens: recorded(usage ? recordedTokens(usage.tokens) : null),
    model: recorded(recordedString(config.model)),
    provider: recorded(recordedString(providerIdentity(config))),
    // The pass's time SPAN, not one instant. A review's spawns run over many minutes and time IS a
    // pricing input (DeepSeek's peak windows begin at 01:00/06:00 UTC), so a single timestamp would
    // silently misprice every review that straddles a boundary. Two ends let a restatement price
    // exactly when they fall in one window, and say so when they do not.
    from: recorded(recordedString(span.from)),
    to: recorded(recordedString(span.to)),
  };
}

// The reader's predicates answer `null` for "nothing recorded"; the writer spells that as an ABSENT
// field. Both read back as an absence, so this is presentation rather than meaning — but it keeps the
// payload a record of facts rather than a roll-call of gaps, on a string paid for at every sink.
function recorded(v) {
  return v === null ? undefined : v;
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
  // "The engine reported nothing" is a usage whose tokens are absent, not a null usage: the record
  // still exists, carrying the host-stamped span (zai-timing-31d.4). Either way there is no cost
  // line to render — same output as before the span learned to survive a token-less spawn.
  if (!usage || !usage.tokens) return '';
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
  unpriced: (cost, tag, config) => {
    const remedy = UNPRICED_REMEDY[cost.reason];
    // [LAW:no-silent-failure] An unlisted reason THROWS rather than falling through to whichever
    // message sits last: the reasons are a closed set, and a new one silently borrowing another's
    // remedy is how a maintainer gets sent to fix the wrong thing.
    if (!remedy) throw new Error(`unknown unpriced reason "${cost.reason}"; add it to UNPRICED_REMEDY`);
    return remedy(tag, config);
  },
};

// [LAW:dataflow-not-control-flow] One line per reason, selected by the reason VALUE — the same shape
// scripts/check-price-freshness.js uses for its staleness reasons. Each names the remedy that actually
// helps, which is the entire reason the reasons are distinct values instead of one null.
const UNPRICED_REMEDY = {
  'no-price': (tag) => `No price-table entry for ${tag}; the review footer shows cost as "unknown". `
    + 'Add the model to PRICE_SOURCES in src/usage.js, under the vendor page that prices it.',
  'schedule-gap': (tag) => `${tag} is in the price table, but no rate card in its schedule covers this `
    + 'spawn, so the review footer shows cost as "unknown". Either the vendor publishes no rate for '
    + 'this spawn (OpenAI prices gpt-5.5 and gpt-5.4 only up to 272K context), or the spawn is too '
    + "large for its per-request context length to be proven from the run's token totals. Nothing is "
    + 'wrong with the table: a rate that cannot be shown to apply is reported unknown rather than guessed.',
  'not-reported': (tag, config) => `${config.engine} reported no cost (no USD in its output) for ${tag}; `
    + 'the review footer shows cost as "unknown".',
};

function costWarning(usage, config) {
  // Tokens and cost go absent together when the engine reported nothing; the usage record itself
  // may still exist to carry the spawn's span (zai-timing-31d.4). Both shapes warn identically.
  if (!usage || !usage.cost) return 'Engine reported no token usage; the review footer omits the cost line.';
  return COST_WARNING[usage.cost.basis](usage.cost, reviewerTag(config), config);
}

module.exports = {
  PRICES_PER_MILLION,
  PRICE_SOURCES,
  PRICE_VERIFICATION_MAX_AGE_DAYS,
  stalePriceSources,
  priceFromTable,
  // Exported for its own unit tests only — the axis-matching rule is the fragile part of the schedule
  // and deserves to be driven directly, including its loud arm. [LAW:behavior-not-structure]
  ratesAt,
  spawnFromTokens,
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
