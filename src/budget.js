'use strict';

const { TIER_RANK } = require('./effort');

// The budget gradient's pure decision (zai-budget-qzm.4): given the day's spend so far, the daily
// budget, this review's diff size, and the candidate effort profiles, pick the highest-effort profile
// this review can afford. No IO — the ledger read (spend so far) and the profile override happen at
// the run() boundary (zai-budget-qzm.5); this module is the pure core between those effects.
// [LAW:effects-at-boundaries] [LAW:dataflow-not-control-flow] the chosen profile is a VALUE selected
// from the candidate set, never a branch that skips the review — the epic's bar is a soft GRADIENT
// (spend less as the day depletes), NEVER a hard cutoff, so this function is TOTAL: it always returns a
// profile, and the worst case is the cheapest candidate.
//
// TWO parts at a real joint [LAW:decomposition]: estimatedCostUsd ranks the cost of ONE profile at a
// given diff (a reusable ranker); chooseProfile selects the affordable best from a candidate set (it
// consumes the estimate). Neither fuses with the other's concern.

// [LAW:one-source-of-truth] Calibration constants — the token/price model MEASURED on 21 real review
// rounds in the spike (zai-budget-qzm.1), mined from this repo's own dogfooded PR reviews (#75–#85,
// claude-code/deepseek-v4-pro). Like PRICES_PER_MILLION in usage.js this is a representation that
// DRIFTS from reality and has no machine source — it is hand-maintained and RECALIBRATED per model.
// Source / last measured: spike zai-budget-qzm.1 findings, 2026-07-11.
//   FIXED_TOKENS        ~178k input tokens every round pays regardless of diff (scout + instructions
//                       + reads + reasoning + MCP) — cost is fixed-DOMINATED for small diffs.
//   MARGINAL_TOKENS/line ~2914 input tokens per churn line (add+del) — the modest per-diff marginal.
//   BLENDED_USD_PER_TOKEN ~$0.12 per 1M tokens EFFECTIVE (most tokens are cache hits at $0.003625/M
//                       vs $0.435/M list; the hit RATIO swings run to run → the ~25% absolute noise).
const CALIBRATION = {
  FIXED_TOKENS: 178_000,
  MARGINAL_TOKENS_PER_LINE: 2_914,
  BLENDED_USD_PER_TOKEN: 0.12 / 1_000_000,
};

// [LAW:no-silent-failure] The cost rank of roundCap's "unlimited" sentinel (0, per effort.js). An
// unlimited review runs to CONVERGENCE (empirically ~5–8 rounds), so it is the MOST expensive profile,
// not the cheapest. A naive `perRoundBase × roundCap` would estimate the sentinel at $0 — always
// "affordable" — silently defeating the entire budget on the most expensive profile. Mapping 0 to a
// rank ABOVE any typical finite cap keeps the ranker honest and monotonic (unlimited ≥ any finite cap).
const UNLIMITED_EFFECTIVE_ROUNDS = 8;

// [LAW:no-mode-explosion] Policy tunables — internal named constants, NOT action inputs. The only knob
// exposed to consumers is DAILY_BUDGET_USD (wired in zai-budget-qzm.5); everything else is sane
// documented default, tuned in this one place.
//   CAP_FRACTION  each review may spend at most this fraction of what REMAINS of the day's budget. A
//                 fraction-of-remaining cap decays GEOMETRICALLY as the day depletes (it asymptotes to
//                 zero but never reaches it), so the budget rations itself across the day rather than
//                 running full effort until a hard wall. This IS the gradient.
//   MIN_CAP_USD   floor under the cap so it never decays to zero: a low-effort review stays affordable
//                 deep into the budget. (The ultimate "a review always runs" guarantee is the selection
//                 fallback below — this floor keeps the cap itself sane; the fallback covers the
//                 pathological case where even the cheapest candidate exceeds the floored cap.)
const CAP_FRACTION = 0.1;
const MIN_CAP_USD = 0.1;

// [LAW:one-source-of-truth] The per-round cost MULTIPLIER of each reasoning tier, indexed by TIER_RANK
// ordinal (0=minimal … 4=xhigh/max). Higher reasoning spends more output/thinking tokens per round, so
// it is a monotonic multiplicand on the round cost — the axis that lets difficulty RAISE effort for a
// complex diff (zai-difficulty-0ea.3). Like CALIBRATION and PRICES_PER_MILLION this is a hand-tuned
// representation with NO machine source: reasoning-token overhead was not separately metered in the
// budget spike, so these are conservative ESTIMATES expected to drift and be recalibrated per model.
// [LAW:verifiable-goals] estimatedCostUsd is a fixed-diff RANKER, not a dollar oracle — what MUST hold
// is STRICT MONOTONICITY in rank (a higher tier always ranks costlier), which is what tests assert; the
// absolute factors are secondary. The baseline (`null` tier = "no raise; the config's own tier stands")
// is factor 1.0: it prices as the round's unraised cost, which is the correct RANK floor even though the
// config's real tier is unknown here — consistent with the ranker-not-oracle contract above.
// Source / last estimated: zai-difficulty-0ea.3, 2026-07-19 (UNMEASURED — recalibrate when metered).
// STRICTLY increasing across every rank so the data actually satisfies the invariant above — 'minimal'
// and 'low' differ (more reasoning always costs at least marginally more; equal factors would be a false
// theorem the comment claims but the data denies). null (baseline) prices at 1.0 like rank-0 'minimal':
// null is the ABSENCE of a raise, not a rank, so it may share minimal's floor without breaking the
// per-rank strict order 1.0 < 1.05 < 1.3 < 1.7 < 2.2.
const REASONING_COST_MULTIPLIER = [1.0, 1.05, 1.3, 1.7, 2.2];

// [LAW:single-enforcer] [LAW:one-source-of-truth] The multiplier is indexed by TIER_RANK ordinal, so this
// array and effort.js's TIER_RANK must cover the SAME rank space. A desync — a rank added to TIER_RANK
// with no multiplier entry — would index past the array and price that tier as undefined → NaN, silently
// corrupting budget ranking (a NaN estimate never satisfies `<= cap`, so the candidate is skipped). Assert
// the coverage ONCE here at module load, so the desync fails loud at startup [LAW:no-silent-failure] — the
// invariant stated explicitly at the definition site, not left implicit to be caught only at test time and
// NOT a per-call guard (that would be control-flow in disguise on the hot path [LAW:no-defensive-null-guards]).
// The check is EXACT (=== ranks+1), not merely "long enough": a too-SHORT array indexes past the end → NaN;
// a too-LONG array carries a dead multiplier for a rank that doesn't exist — a latent [LAW:one-source-of-truth]
// drift. Both directions fail loud, keeping the two tables in exact correspondence (one multiplier per rank).
const MAX_TIER_RANK = Math.max(...Object.values(TIER_RANK));
if (REASONING_COST_MULTIPLIER.length !== MAX_TIER_RANK + 1) {
  throw new Error(
    `REASONING_COST_MULTIPLIER has ${REASONING_COST_MULTIPLIER.length} entries but TIER_RANK needs exactly `
    + `${MAX_TIER_RANK + 1} (one per rank 0..${MAX_TIER_RANK}); keep the two tables in exact correspondence.`,
  );
}

// [LAW:effects-at-boundaries] Pure: the estimated USD cost of running ONE review round at this diff.
// diffSize is CHURN (added + deleted lines) — the axis the spike measured cost against. The fixed
// floor dominates for small diffs; the marginal adds a modest per-line term.
function perRoundBaseUsd(diffSize) {
  const tokens = CALIBRATION.FIXED_TOKENS + CALIBRATION.MARGINAL_TOKENS_PER_LINE * diffSize;
  return tokens * CALIBRATION.BLENDED_USD_PER_TOKEN;
}

// [LAW:effects-at-boundaries] Pure. The number of rounds this profile's roundCap will actually cost.
// [LAW:dataflow-not-control-flow] the sentinel 0 ("unlimited") is a VALUE mapped to its true cost rank,
// not a branch that skips the multiply — see UNLIMITED_EFFECTIVE_ROUNDS for why 0 must NOT mean 0 cost.
function effectiveRounds(roundCap) {
  return roundCap === 0 ? UNLIMITED_EFFECTIVE_ROUNDS : roundCap;
}

// [LAW:effects-at-boundaries] Pure. The per-round cost multiplier of a profile's convergence-sweep
// bound (zai-recall-upr.2): each sweep re-runs the whole worker layer over the same material, so a
// round costs up to (1 + sweepCap) worker passes. Priced at the CAP, not the expectation — sweeps
// terminate early on convergence, but roundCap already prices its cap the same way, and over-pricing
// only de-rates earlier (the safe direction for a budget). The scout a sweep skips is one spawn among
// many, so a sweep pricing as a full pass is a conservative, monotonic approximation.
// [LAW:verifiable-goals] like the tier multiplier, this is a RANKER term: what must hold is strict
// monotonicity in sweepCap, not dollar accuracy. [LAW:no-silent-failure] a malformed cap is a caller
// bug — throw rather than silently pricing a profile at NaN (a NaN estimate never satisfies `<= cap`,
// silently skipping the candidate).
function sweepFactor(sweepCap) {
  if (!Number.isInteger(sweepCap) || sweepCap < 0) {
    throw new Error(`Invalid sweepCap ${JSON.stringify(sweepCap)}: expected a non-negative integer.`);
  }
  return 1 + sweepCap;
}

// [LAW:effects-at-boundaries] Pure. The per-round cost multiplier of a reasoning tier.
// [LAW:dataflow-not-control-flow] the baseline `null`/`undefined` tier is a VALUE mapped to 1.0 (no
// raise), not a branch that skips the multiply — so estimatedCostUsd multiplies unconditionally and a
// default profile prices exactly as before. [LAW:no-silent-failure] an unknown tier string is a caller
// bug (a proposal outside the vocabulary), not a value to price at 1.0 — throw naming the known tiers,
// rather than silently under-pricing a raised profile and letting the budget over-spend.
function reasoningFactor(tier) {
  if (tier === null || tier === undefined) return 1.0;
  if (!Object.prototype.hasOwnProperty.call(TIER_RANK, tier)) {
    throw new Error(
      `Unknown reasoning tier ${JSON.stringify(tier)}. Known tiers: ${Object.keys(TIER_RANK).join(', ')}.`,
    );
  }
  return REASONING_COST_MULTIPLIER[TIER_RANK[tier]];
}

// [LAW:effects-at-boundaries] Pure. The deterministic cost ESTIMATE for a profile at a diff.
// [LAW:verifiable-goals] It is a fixed-diff RANKER, NOT a dollar oracle: absolute cost is ~25% noisy
// (cache-ratio variance), but at a FIXED diff perRoundBase is constant, so the ordering across
// candidates is driven purely by the monotonic cost-bearing axes → exact tier ranking despite the
// absolute noise. Tests assert monotonicity + reproducibility, NEVER absolute dollars.
// [LAW:types-are-the-program] EffortProfile now carries THREE cost-bearing axes, all priced HERE as
// independent monotonic multiplicands on the per-round base: roundCap (how many rounds), sweepCap
// (how many convergence passes each round runs — landed in zai-recall-upr.2 with its consumer, the
// sweep loop in runMultiScopePass), and reasoningTier (how hard each pass reasons — landed in
// zai-difficulty-0ea.3 with its consumer, the reasoning fold at the runMultiScope seam). modelTier
// becomes a fourth when its consumer migrates; reading an axis before the type carries it would be
// the false theorem effort.js refuses.
// [LAW:dataflow-not-control-flow] the product is total — every profile prices, a null reasoningTier
// multiplies by 1.0 and a sweepCap of 0 by 1, so a roundCap-only profile is unchanged.
function estimatedCostUsd(profile, diffSize) {
  return perRoundBaseUsd(diffSize)
    * effectiveRounds(profile.roundCap)
    * sweepFactor(profile.sweepCap)
    * reasoningFactor(profile.reasoningTier);
}

// [LAW:effects-at-boundaries] Pure. The per-review spend cap: a floored fraction of REMAINING budget.
// remaining is clamped at ≥0 so an already-overspent day (spentToday > dailyBudget) yields the floor,
// never a negative cap. [LAW:dataflow-not-control-flow] no special "budget is zero/negative" mode — the
// off-switch (budget unset) is the wiring's concern (zai-budget-qzm.5 never calls this when off); here
// the value simply flows through and floors.
function perReviewCapUsd(spentToday, dailyBudget) {
  const remaining = Math.max(0, dailyBudget - spentToday);
  return Math.max(MIN_CAP_USD, CAP_FRACTION * remaining);
}

// [LAW:effects-at-boundaries] Pure. Choose the affordable best effort profile.
// [LAW:dataflow-not-control-flow] The result is always a VALUE selected from `candidates`: the
// highest-cost candidate whose estimate fits the cap, or — when even the cheapest exceeds the cap — the
// cheapest candidate, so a minimal review ALWAYS runs (the epic's gradient, never a cutoff). Ranking by
// estimate IS ranking by effort at a fixed diff (the cost-bearing axes are monotonic), and it is the
// cost-truthful ordering because cost is exactly what the cap bounds.
// [LAW:composability] asks nothing of the caller's ordering — it ranks the candidates itself, so a
// difficulty proposal (zai-difficulty-0ea) can hand its ladder in any order and get the affordable best.
// [LAW:no-silent-failure] an empty candidate set has no honest answer; it is a caller contract breach
// (there is always at least the default profile), so throw loudly rather than return null and push a
// null-guard onto the wiring. [LAW:no-defensive-null-guards]
function chooseProfile({ candidates, spentToday, dailyBudget, diffSize }) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('chooseProfile requires a non-empty candidates array (at least the default profile).');
  }
  const capUsd = perReviewCapUsd(spentToday, dailyBudget);

  // Rank ascending by estimate (cheapest → most expensive). At a fixed diff this is effort order.
  const ranked = candidates
    .map((profile) => ({ profile, estimatedUsd: estimatedCostUsd(profile, diffSize) }))
    .sort((a, b) => a.estimatedUsd - b.estimatedUsd);

  // The highest-cost candidate within the cap; if none fits, the cheapest — the minimal-review floor.
  const affordable = ranked.filter((r) => r.estimatedUsd <= capUsd);
  const chosen = affordable.length > 0 ? affordable[affordable.length - 1] : ranked[0];

  return {
    profile: chosen.profile,
    estimatedUsd: chosen.estimatedUsd,
    capUsd,
    withinCap: chosen.estimatedUsd <= capUsd,
  };
}

// [LAW:no-silent-failure] Parse the DAILY_BUDGET_USD action input at the run boundary. Unset/empty is
// the OFF state — the value 0 — NOT an error: the budget gradient is opt-in and its absence is today's
// default path ([LAW:no-mode-explosion], the off state is not a new mode). A present-but-malformed value
// (non-numeric, negative) is a config error that reds the run loud, never a silent fall-back to off that
// would let a fat-fingered budget silently overspend. Returns a number; >0 means the gradient is active.
function parseDailyBudgetUsd(raw) {
  const s = (raw || '').trim();
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `Invalid DAILY_BUDGET_USD ${JSON.stringify(raw)}: expected a non-negative number ` +
      '(unset or 0 = budget gradient off).',
    );
  }
  return n;
}

// [LAW:no-silent-failure] The de-rate rungs the budget offers BELOW the configured full effort. Fixed
// today (the difficulty epic zai-difficulty-0ea will later PROPOSE the candidate set); a rung is kept
// only when it is strictly cheaper than the top, so the ladder never RAISES effort above the user's cap.
const DERATE_ROUNDCAPS = [1, 2, 3];

// [LAW:effects-at-boundaries] Pure. The candidate profiles the budget policy ranks: the user's
// configured full-effort profile (`topProfile`, the ceiling budget must never exceed) plus cheaper
// de-rated rungs below it. [LAW:dataflow-not-control-flow] the ceiling is a VALUE — effectiveRounds
// folds the 0="unlimited" sentinel to its true cost rank (8), so a rung is included iff it is genuinely
// cheaper than the top, whether the top is a finite cap or unlimited. Budget only ever CAPS: because the
// top is always a candidate and every other is cheaper, chooseProfile's worst case is `topProfile`
// itself and its best case is the cheapest rung — never anything above the configured effort.
// [LAW:carrying-cost] de-rating touches only roundCap (the sole cost-bearing axis today); as the profile
// grows cost-bearing axes, each gets its own de-rating HERE, and the spread carries the rest unchanged.
function defaultBudgetCandidates(topProfile) {
  const ceiling = effectiveRounds(topProfile.roundCap);
  const rungs = DERATE_ROUNDCAPS
    .filter((roundCap) => roundCap < ceiling)
    .map((roundCap) => ({ ...topProfile, roundCap }));
  return [...rungs, topProfile];
}

module.exports = {
  CALIBRATION,
  UNLIMITED_EFFECTIVE_ROUNDS,
  CAP_FRACTION,
  MIN_CAP_USD,
  DERATE_ROUNDCAPS,
  REASONING_COST_MULTIPLIER,
  effectiveRounds,
  sweepFactor,
  reasoningFactor,
  estimatedCostUsd,
  perReviewCapUsd,
  chooseProfile,
  parseDailyBudgetUsd,
  defaultBudgetCandidates,
};
