'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  UNLIMITED_EFFECTIVE_ROUNDS,
  MIN_CAP_USD,
  CAP_FRACTION,
  estimatedCostUsd,
  sweepFactor,
  reasoningFactor,
  perReviewCapUsd,
  chooseProfile,
} = require('../src/budget');
const { defaultEffortProfile, TIER_RANK } = require('../src/effort');

// Candidates are real EffortProfile values built through the actual constructor — proving the policy
// composes with the shipped type, not a hand-rolled stand-in. A ladder of roundCaps is the shape the
// budget wiring (zai-budget-qzm.5) will hand in.
const profile = (roundCap) => defaultEffortProfile({ roundCap });
const LADDER = [profile(1), profile(2), profile(3), profile(5)];

describe('estimatedCostUsd — a fixed-diff RANKER, asserted by ordering never by absolute dollars', () => {
  test('monotonic in roundCap at a fixed diff (higher cap ⇒ higher estimate)', () => {
    const diff = 100;
    const e1 = estimatedCostUsd(profile(1), diff);
    const e2 = estimatedCostUsd(profile(2), diff);
    const e3 = estimatedCostUsd(profile(3), diff);
    assert.ok(e1 < e2 && e2 < e3, `expected strictly increasing, got ${e1}, ${e2}, ${e3}`);
  });

  test('monotonic in diffSize at a fixed roundCap (more churn ⇒ higher estimate)', () => {
    const small = estimatedCostUsd(profile(2), 10);
    const large = estimatedCostUsd(profile(2), 800);
    assert.ok(small < large, `expected ${small} < ${large}`);
  });

  test('the roundCap=0 "unlimited" sentinel ranks as the MOST expensive, never $0 (the anti-$0 trap)', () => {
    const diff = 100;
    // A naive `perRoundBase × roundCap` would make unlimited estimate at $0 — always affordable —
    // silently defeating the budget. It must rank above any typical finite cap.
    assert.ok(estimatedCostUsd(profile(0), diff) > estimatedCostUsd(profile(5), diff));
    assert.equal(
      estimatedCostUsd(profile(0), diff),
      estimatedCostUsd(profile(UNLIMITED_EFFECTIVE_ROUNDS), diff),
    );
  });

  test('positive even at diffSize=0 — the fixed token floor dominates', () => {
    assert.ok(estimatedCostUsd(profile(1), 0) > 0);
  });

  test('pure/reproducible — identical inputs yield identical output', () => {
    assert.equal(estimatedCostUsd(profile(3), 250), estimatedCostUsd(profile(3), 250));
  });

  // reasoningTier is the SECOND cost-bearing axis (zai-difficulty-0ea.3): a monotonic multiplicand that
  // lets difficulty RAISE effort. As with roundCap, the contract is ORDERING, never absolute dollars.
  const withTier = (roundCap, reasoningTier) => defaultEffortProfile({ roundCap, reasoningTier });

  test('a null reasoningTier prices EXACTLY as the roundCap-only profile did (byte-identical baseline)', () => {
    const diff = 100;
    assert.equal(estimatedCostUsd(withTier(3, null), diff), estimatedCostUsd(profile(3), diff));
  });

  test('STRICTLY monotonic in reasoningTier at a fixed roundCap+diff (harder reasoning ⇒ strictly higher estimate)', () => {
    const diff = 100;
    const tiers = ['minimal', 'low', 'medium', 'high', 'xhigh'];
    const costs = tiers.map((t) => estimatedCostUsd(withTier(3, t), diff));
    for (let i = 1; i < costs.length; i++) {
      assert.ok(costs[i] > costs[i - 1], `tier ${tiers[i]} (${costs[i]}) must be STRICTLY > ${tiers[i - 1]} (${costs[i - 1]})`);
    }
  });

  test('a raised reasoning tier can cost MORE than the same roundCap at baseline — the RAISE is real', () => {
    const diff = 100;
    assert.ok(estimatedCostUsd(withTier(3, 'high'), diff) > estimatedCostUsd(withTier(3, null), diff));
  });

  test('reasoningFactor: null baseline is 1.0, STRICTLY monotonic across distinct TIER_RANK ranks', () => {
    assert.equal(reasoningFactor(null), 1.0);
    assert.equal(reasoningFactor(undefined), 1.0);
    // Group tiers by rank (xhigh and max share rank 4 — same rung, so same factor), then assert the
    // factor is STRICTLY increasing as the rank increases. A per-tier strict check would wrongly demand
    // xhigh < max; the invariant is over distinct RANKS, not tier names.
    const byRank = [...new Set(Object.values(TIER_RANK))].sort((a, b) => a - b);
    const factorForRank = (rank) => reasoningFactor(Object.keys(TIER_RANK).find((t) => TIER_RANK[t] === rank));
    let prev = 0;
    for (const rank of byRank) {
      const f = factorForRank(rank);
      assert.ok(f > prev, `factor for rank ${rank} (${f}) must be STRICTLY > the lower rank (${prev})`);
      prev = f;
    }
    // same-rank tiers price identically (xhigh === max)
    assert.equal(reasoningFactor('xhigh'), reasoningFactor('max'));
  });

  test('reasoningFactor: an unknown tier throws — never silently under-prices a raised profile', () => {
    assert.throws(() => reasoningFactor('turbo'), /Unknown reasoning tier/);
  });
});

// The convergence-sweep multiplicand (zai-recall-upr.2): each sweep re-runs the worker layer, so a
// round prices at (1 + sweepCap) passes — priced at the cap, like roundCap, never the expectation.
describe('sweepFactor — the convergence-sweep cost multiplicand', () => {
  test('monotonic in sweepCap, with 0 sweeps as the neutral 1× (a pre-sweep profile is unchanged)', () => {
    assert.equal(sweepFactor(0), 1);
    assert.ok(sweepFactor(1) < sweepFactor(2) && sweepFactor(2) < sweepFactor(3));
  });

  test('estimatedCostUsd is monotonic in sweepCap at a fixed diff and roundCap', () => {
    const at = (sweepCap) => estimatedCostUsd(defaultEffortProfile({ roundCap: 2, sweepCap }), 100);
    assert.ok(at(0) < at(1) && at(1) < at(2), `expected strictly increasing, got ${at(0)}, ${at(1)}, ${at(2)}`);
  });

  test('a malformed sweepCap throws loudly — never a NaN estimate that silently skips the candidate', () => {
    for (const bad of [undefined, null, -1, 1.5, 'two']) {
      assert.throws(() => sweepFactor(bad), /Invalid sweepCap/);
    }
  });
});

describe('perReviewCapUsd — a floored fraction of REMAINING budget', () => {
  test('is CAP_FRACTION of remaining when that exceeds the floor (decays as the day depletes)', () => {
    assert.equal(perReviewCapUsd(0, 10), CAP_FRACTION * 10);
    assert.equal(perReviewCapUsd(5, 10), CAP_FRACTION * 5);
    assert.ok(perReviewCapUsd(5, 10) < perReviewCapUsd(0, 10)); // spent more ⇒ smaller cap
  });

  test('never decays below MIN_CAP_USD — a minimal review stays affordable deep into the budget', () => {
    assert.equal(perReviewCapUsd(9.99, 10), MIN_CAP_USD);
  });

  test('an overspent day (spentToday > dailyBudget) floors the cap, never goes negative', () => {
    assert.equal(perReviewCapUsd(15, 10), MIN_CAP_USD);
  });
});

describe('chooseProfile — the gradient: pick the affordable best, always return a profile', () => {
  test('picks the highest-effort candidate under a generous cap', () => {
    const { profile: chosen, withinCap } = chooseProfile({
      candidates: LADDER, spentToday: 0, dailyBudget: 10, diffSize: 100,
    });
    assert.equal(chosen.roundCap, 5); // the top of the ladder fits early in the day
    assert.equal(withinCap, true);
  });

  test('DE-RATES as the day depletes — higher spentToday selects a lower roundCap (the gradient)', () => {
    const pick = (spentToday) => chooseProfile({
      candidates: LADDER, spentToday, dailyBudget: 10, diffSize: 100,
    }).profile.roundCap;
    // Depletion points chosen to hit three distinct rungs at the default profile's estimate scale
    // (which includes the convergence-sweep multiplicand, zai-recall-upr.2).
    const early = pick(0);
    const mid = pick(5);
    const late = pick(8);
    assert.ok(early > mid && mid > late, `expected strictly decreasing effort, got ${early}, ${mid}, ${late}`);
  });

  test('FLOOR: when even the cheapest candidate exceeds the cap, still returns it — a minimal review always runs', () => {
    // A large diff makes every candidate cost more than the floored cap; the epic's bar is a gradient,
    // NOT a cutoff, so the policy must still return the cheapest profile, flagged withinCap=false.
    const { profile: chosen, withinCap } = chooseProfile({
      candidates: LADDER, spentToday: 100, dailyBudget: 10, diffSize: 2000,
    });
    assert.equal(chosen.roundCap, 1); // the cheapest candidate
    assert.equal(withinCap, false); // fell back through the floor, honestly reported
  });

  test('order-independent — a shuffled candidate set yields the same choice', () => {
    const shuffled = [profile(3), profile(5), profile(1), profile(2)];
    const a = chooseProfile({ candidates: LADDER, spentToday: 8, dailyBudget: 10, diffSize: 100 });
    const b = chooseProfile({ candidates: shuffled, spentToday: 8, dailyBudget: 10, diffSize: 100 });
    assert.equal(a.profile.roundCap, b.profile.roundCap);
  });

  test('returns a profile BY IDENTITY from the candidate set — never a synthesized value', () => {
    const target = profile(2);
    const candidates = [profile(5), target, profile(3)];
    // Tune spend so the floored cap admits roundCap≤2 but not 3 at this diff (highest-affordable = 2).
    const { profile: chosen } = chooseProfile({
      candidates, spentToday: 8.7, dailyBudget: 10, diffSize: 100,
    });
    assert.equal(chosen, target); // same object reference, not an equal copy
  });

  test('empty candidate set is a caller contract breach — throws loudly, never returns null', () => {
    assert.throws(() => chooseProfile({ candidates: [], spentToday: 0, dailyBudget: 10, diffSize: 100 }), /non-empty/);
  });
});
