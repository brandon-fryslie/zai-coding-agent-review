'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DIFFICULTY_BANDS,
  DIFFICULTY_REASONING_BANDS,
  selectBand,
  roundCapRank,
  reasoningBandRank,
  effortMagnitude,
  difficultyCandidates,
  parseDifficultyScaling,
} = require('../src/difficulty-policy');
const { defaultEffortProfile, TIER_RANK } = require('../src/effort');
const { estimatedCostUsd, effectiveRounds } = require('../src/budget');
const { resolveDifficultyEffort, bindingLevers } = require('../src/run');

// The most expensive candidate in a ladder — the difficulty-proposed CEILING, which chooseProfile picks
// when no budget cap binds. defaultBudgetCandidates returns the top last, but rank by cost so the test
// asserts on meaning, not array order. [LAW:behavior-not-structure]
const topCap = (candidates, diffSize = 100) =>
  candidates.reduce((a, b) => (estimatedCostUsd(b, diffSize) > estimatedCostUsd(a, diffSize) ? b : a)).roundCap;

// Difficulty VALUES built directly (difficultyCandidates consumes assessDifficulty's shape, not files),
// so each band is exercised by an exact, eyeball-checkable magnitude rather than a hand-tuned patch.
const diff = (churn, kinds) => ({ churn, kinds: { source: 0, tests: 0, docs: 0, ...kinds } });

describe('effortMagnitude — churn + spread surcharge, discounted when no source is touched', () => {
  test('a source change costs its churn plus a per-file surcharge', () => {
    // (churn 3 + 8*1 file) * sourceFactor 1 = 11
    assert.equal(effortMagnitude(diff(3, { source: 1 })), 11);
  });

  test('spread adds even when churn is tiny (a wide, thin change is not trivial)', () => {
    // (churn 5 + 8*10 files) * 1 = 85 — an order of magnitude above the same churn in one file (13)
    assert.equal(effortMagnitude(diff(5, { source: 10 })), 85);
    assert.ok(effortMagnitude(diff(5, { source: 10 })) > effortMagnitude(diff(5, { source: 1 })));
  });

  test('a tests-only / docs-only change is discounted (no source touched)', () => {
    // Same churn+spread, but source:0 scales the magnitude down by NONSOURCE_DISCOUNT.
    assert.ok(effortMagnitude(diff(40, { docs: 1 })) < effortMagnitude(diff(40, { source: 1 })));
    // (40 + 8) * 0.4 = 19.2
    assert.equal(Math.round(effortMagnitude(diff(40, { docs: 1 })) * 10) / 10, 19.2);
  });

  // [LAW:verifiable-goals] Regression guard for FP precision at band boundaries. NONSOURCE_DISCOUNT (0.4)
  // is not exactly representable, so a non-source magnitude that mathematically equals a boundary (20, 80,
  // 250) COULD in principle land just above it and misclassify. It does not: 50*0.4, 200*0.4, 625*0.4 all
  // round to exactly 20/80/250 in IEEE-754. This pins that — a future change to the discount or a band
  // value that broke the exactness would fail here, loudly, instead of silently mis-rating a boundary
  // change one round too expensive. Asserted through the REAL multiplication path, not a hand-typed float.
  test('exact-boundary magnitudes hit the boundary precisely through the *0.4 discount path', () => {
    // churn + 8*spread chosen so (churn + 8) * 0.4 lands ON each boundary: 50→20, 200→80, 625→250.
    assert.equal(effortMagnitude(diff(42, { docs: 1 })), 20);   // 50 * 0.4
    assert.equal(effortMagnitude(diff(192, { tests: 1 })), 80); // 200 * 0.4
    assert.equal(effortMagnitude(diff(617, { docs: 1 })), 250); // 625 * 0.4
    // And the inclusive `<=` contract holds: magnitude exactly 20 is band 1, not band 2.
    assert.equal(topCap(difficultyCandidates(diff(42, { docs: 1 }), defaultEffortProfile({ roundCap: 5 }))), 1);
  });
});

describe('selectBand — the covering band, chosen independent of array order', () => {
  test('picks the smallest maxMagnitude that still covers the magnitude', () => {
    assert.equal(selectBand(DIFFICULTY_BANDS, 5, roundCapRank).roundCap, 1);   // covered by 20 (smallest covering)
    assert.equal(selectBand(DIFFICULTY_BANDS, 20, roundCapRank).roundCap, 1);  // boundary is inclusive
    assert.equal(selectBand(DIFFICULTY_BANDS, 21, roundCapRank).roundCap, 2);  // just past 20 → next band
    assert.equal(selectBand(DIFFICULTY_BANDS, 250, roundCapRank).roundCap, 3);
  });

  test('null when no band covers the magnitude (it exceeds every band)', () => {
    assert.equal(selectBand(DIFFICULTY_BANDS, 10_000, roundCapRank), null);
  });

  test('[LAW:types-are-the-program] a shuffled band table yields the IDENTICAL selection — order carries no meaning', () => {
    // The exact failure the reviewer flagged: a higher band listed before a lower one must NOT let a small
    // magnitude match the higher band first. selectBand is by-value, so a reversed table is equivalent.
    const reversed = [...DIFFICULTY_BANDS].reverse();
    const scrambled = [DIFFICULTY_BANDS[1], DIFFICULTY_BANDS[2], DIFFICULTY_BANDS[0]];
    for (const mag of [0, 5, 20, 21, 79, 80, 81, 250, 251, 9999]) {
      assert.deepEqual(selectBand(reversed, mag, roundCapRank), selectBand(DIFFICULTY_BANDS, mag, roundCapRank), `reversed @ ${mag}`);
      assert.deepEqual(selectBand(scrambled, mag, roundCapRank), selectBand(DIFFICULTY_BANDS, mag, roundCapRank), `scrambled @ ${mag}`);
    }
  });

  test('[LAW:types-are-the-program] a duplicate-maxMagnitude table selects deterministically — the cheaper rung, any order', () => {
    // A degenerate table the type admits: two bands share a maxMagnitude. The explicit tie-break (smaller
    // roundCap wins) makes selection deterministic and order-independent — the reduce never silently keeps
    // whichever the array happened to list first.
    const dup = [{ maxMagnitude: 50, roundCap: 3 }, { maxMagnitude: 50, roundCap: 1 }];
    assert.deepEqual(selectBand(dup, 40, roundCapRank), { maxMagnitude: 50, roundCap: 1 });
    assert.deepEqual(selectBand([...dup].reverse(), 40, roundCapRank), { maxMagnitude: 50, roundCap: 1 });
  });
});

describe('difficultyCandidates — propose an effort ladder that only ever LOWERS the ceiling', () => {
  const top5 = defaultEffortProfile({ roundCap: 5 });

  test('[ACCEPTANCE] a trivial diff proposes a strictly cheaper top candidate than a large diff', () => {
    const trivial = difficultyCandidates(diff(3, { source: 1 }), top5);   // magnitude 11 → band roundCap 1
    const large = difficultyCandidates(diff(400, { source: 6 }), top5);   // magnitude 448 → full ceiling 5
    // The ceiling chooseProfile would pick with no budget cap: trivial is cheaper than large.
    assert.ok(
      estimatedCostUsd({ ...top5, roundCap: topCap(trivial) }, 100)
      < estimatedCostUsd({ ...top5, roundCap: topCap(large) }, 100),
      'trivial diff must propose a cheaper ceiling than a large diff',
    );
    assert.equal(topCap(trivial), 1);
    assert.equal(topCap(large), 5);
  });

  test('[ACCEPTANCE] the user ceiling is NEVER exceeded — difficulty only caps DOWN', () => {
    const top2 = defaultEffortProfile({ roundCap: 2 });
    // A moderate diff whose band would propose roundCap 3, under a user cap of 2: the proposal is clamped
    // to the user's ceiling, never raised. [LAW:types-are-the-program] this slice cannot raise effort.
    const moderateUnderLowCap = difficultyCandidates(diff(150, { source: 1 }), top2); // band → 3, clamped to 2
    for (const c of moderateUnderLowCap) {
      assert.ok(effectiveRounds(c.roundCap) <= effectiveRounds(top2.roundCap), `candidate ${c.roundCap} exceeds ceiling 2`);
    }
    assert.equal(topCap(moderateUnderLowCap), 2);
    // A large diff under the low cap likewise tops out at the user's ceiling, not above.
    const largeUnderLowCap = difficultyCandidates(diff(400, { source: 6 }), top2);
    assert.equal(topCap(largeUnderLowCap), 2);
  });

  test('the bands are monotone: churn climbing lifts the proposed ceiling, never lowering it', () => {
    const caps = [diff(5, { source: 1 }), diff(50, { source: 1 }), diff(150, { source: 1 }), diff(500, { source: 1 })]
      .map((d) => topCap(difficultyCandidates(d, top5)));
    assert.deepEqual(caps, [1, 2, 3, 5]);
  });

  test('the 0="unlimited" ceiling is capped DOWN to a finite band for an easy change', () => {
    const topUnlimited = defaultEffortProfile({ roundCap: 0 });
    const trivial = difficultyCandidates(diff(3, { source: 1 }), topUnlimited); // band → 1, cheaper than unlimited
    assert.equal(topCap(trivial), 1);
    // No candidate is the unlimited sentinel — the easy change genuinely bounded the run.
    for (const c of trivial) assert.notEqual(c.roundCap, 0);
  });

  test('a substantial change under an unlimited ceiling keeps the unlimited ceiling (no lowering)', () => {
    const topUnlimited = defaultEffortProfile({ roundCap: 0 });
    const large = difficultyCandidates(diff(500, { source: 8 }), topUnlimited); // magnitude > every band → ceiling
    assert.ok(large.some((c) => c.roundCap === 0), 'the unlimited ceiling must remain a candidate for a hard change');
  });

  test('only roundCap moves — the profile\'s other axes are preserved', () => {
    for (const c of difficultyCandidates(diff(3, { source: 1 }), top5)) {
      assert.equal(c.sweepCap, top5.sweepCap);
      assert.equal(c.reasoningTier, top5.reasoningTier);
    }
  });

  test('is reproducible — the same difficulty always yields a deep-equal ladder', () => {
    const d = diff(60, { source: 2, tests: 1 });
    assert.deepEqual(difficultyCandidates(d, top5), difficultyCandidates(d, top5));
  });
});

// The SECOND axis (zai-difficulty-0ea.3): reasoningTier RAISES for complex diffs. The reasoning bands use
// the same selectBand machinery with the TIER_RANK cost extractor, so these assert both the band table
// and that difficultyCandidates offers a genuinely more-expensive candidate for a hard change.
describe('DIFFICULTY_REASONING_BANDS — the reasoning-RAISE bands via selectBand(reasoningBandRank)', () => {
  // [LAW:verifiable-goals] The table's TOTALITY is an explicit tested invariant, not tierAt's silent
  // assumption: a magnitude beyond the largest finite band must still name a tier (the Infinity band). With
  // this asserted, tierAt's direct `.tier` deref is justified — a null here would be a real, loud regression.
  test('the band table is TOTAL — every magnitude is covered (the Infinity band), so selection is never null', () => {
    for (const mag of [0, 250, 251, 600, 601, Number.MAX_VALUE]) {
      assert.notEqual(selectBand(DIFFICULTY_REASONING_BANDS, mag, reasoningBandRank), null, `uncovered @ ${mag}`);
    }
  });

  const tierAt = (magnitude) => selectBand(DIFFICULTY_REASONING_BANDS, magnitude, reasoningBandRank).tier;

  test('no raise up to 250, then high, then max — the covering band by magnitude', () => {
    assert.equal(tierAt(10), null);    // trivial: no raise (roundCap may still LOWER here)
    assert.equal(tierAt(250), null);   // boundary inclusive → still the null band
    assert.equal(tierAt(251), 'high'); // just past → substantial: raise
    assert.equal(tierAt(600), 'high'); // boundary inclusive
    assert.equal(tierAt(601), 'max');  // just past → very large: full depth
    assert.equal(tierAt(10_000), 'max'); // the Infinity band makes the table total
  });

  test('[LAW:no-silent-failure] reasoningBandRank throws on an unknown tier string — a typo can never rank silently', () => {
    assert.equal(reasoningBandRank({ tier: null }), -1);        // the legitimate no-raise band, cheapest
    assert.equal(reasoningBandRank({ tier: 'high' }), TIER_RANK.high);
    assert.throws(() => reasoningBandRank({ tier: 'hihg' }), /unknown tier/i); // a misspelled band row
  });

  test('[LAW:types-are-the-program] a shuffled reasoning-band table yields the IDENTICAL selection', () => {
    const scrambled = [DIFFICULTY_REASONING_BANDS[2], DIFFICULTY_REASONING_BANDS[0], DIFFICULTY_REASONING_BANDS[1]];
    for (const mag of [10, 250, 251, 600, 601, 5000]) {
      assert.deepEqual(
        selectBand(scrambled, mag, reasoningBandRank),
        selectBand(DIFFICULTY_REASONING_BANDS, mag, reasoningBandRank),
        `scrambled @ ${mag}`,
      );
    }
  });

  test('[LAW:types-are-the-program] a duplicate-maxMagnitude table selects deterministically — the cheaper (lower) tier, any order', () => {
    const dup = [{ maxMagnitude: 400, tier: 'max' }, { maxMagnitude: 400, tier: 'high' }];
    assert.equal(selectBand(dup, 300, reasoningBandRank).tier, 'high');
    assert.equal(selectBand([...dup].reverse(), 300, reasoningBandRank).tier, 'high');
  });

  test('the FP boundary is exact — magnitude built through the *0.4 non-source discount path', () => {
    // (churn + 8*spread) * 0.4 = 250 exactly at churn=617, spread=1 (a large tests-only change): still the
    // null band; one churn line more tips it past 250 into 'high'. Guards the ≤ boundary on the discount path.
    assert.equal(effortMagnitude(diff(617, { tests: 1 })), 250);
    assert.equal(selectBand(DIFFICULTY_REASONING_BANDS, effortMagnitude(diff(617, { tests: 1 })), reasoningBandRank).tier, null);
    assert.equal(selectBand(DIFFICULTY_REASONING_BANDS, effortMagnitude(diff(620, { tests: 1 })), reasoningBandRank).tier, 'high');
  });
});

describe('difficultyCandidates — reasoningTier RAISES for complex diffs (the cross product)', () => {
  const top5 = defaultEffortProfile({ roundCap: 5 });
  const tiers = (candidates) => new Set(candidates.map((c) => c.reasoningTier));
  const maxCost = (candidates, diffSize) =>
    candidates.reduce((a, b) => (estimatedCostUsd(b, diffSize) > estimatedCostUsd(a, diffSize) ? b : a));

  test('an easy/moderate change proposes reasoningTier=null on EVERY candidate (byte-identical spend)', () => {
    for (const c of difficultyCandidates(diff(100, { source: 1 }), top5)) { // magnitude 108 → no raise
      assert.equal(c.reasoningTier, null);
    }
  });

  test('a substantial change offers BOTH the baseline (null) and the raised tier at each roundCap rung', () => {
    const candidates = difficultyCandidates(diff(300, { source: 2 }), top5); // magnitude 316 → high
    assert.deepEqual(tiers(candidates), new Set([null, 'high']));
    // cross product: the full-effort rung exists at both baseline and the raise
    assert.ok(candidates.some((c) => c.roundCap === 5 && c.reasoningTier === null));
    assert.ok(candidates.some((c) => c.roundCap === 5 && c.reasoningTier === 'high'));
  });

  test('a very large change raises to max', () => {
    const candidates = difficultyCandidates(diff(700, { source: 2 }), top5); // magnitude 716 → max
    assert.deepEqual(tiers(candidates), new Set([null, 'max']));
  });

  test('[ACCEPTANCE] a complex diff proposes a candidate that costs MORE than the user\'s full-effort default — difficulty RAISES', () => {
    const diffSize = 100;
    const complex = difficultyCandidates(diff(700, { source: 3 }), top5); // magnitude → max
    const proposedTop = maxCost(complex, diffSize);
    // The user's configured ceiling with no raise is the reference; the proposal must exceed it.
    assert.ok(
      estimatedCostUsd(proposedTop, diffSize) > estimatedCostUsd(top5, diffSize),
      `proposed ${JSON.stringify(proposedTop)} must cost more than the default full-effort profile`,
    );
    assert.equal(proposedTop.roundCap, 5);       // rounds not lowered for a hard change
    assert.equal(proposedTop.reasoningTier, 'max'); // reasoning raised
  });

  test('[ACCEPTANCE] a trivial diff still costs strictly LESS than a complex one — both axes point the same way', () => {
    const diffSize = 100;
    const trivial = maxCost(difficultyCandidates(diff(3, { source: 1 }), top5), diffSize);   // roundCap 1, no raise
    const complex = maxCost(difficultyCandidates(diff(700, { source: 3 }), top5), diffSize); // roundCap 5, max reasoning
    assert.ok(estimatedCostUsd(trivial, diffSize) < estimatedCostUsd(complex, diffSize));
  });

  test('is reproducible — the same difficulty always yields a deep-equal cross product', () => {
    const d = diff(300, { source: 2 });
    assert.deepEqual(difficultyCandidates(d, top5), difficultyCandidates(d, top5));
  });
});

// [LAW:no-silent-failure] The off state (unset/false) is a value, not an error; a typo reds the run loud.
describe('parseDifficultyScaling', () => {
  test('unset / empty / false (any case) is the OFF value false', () => {
    for (const off of ['', '   ', undefined, 'false', 'FALSE', ' false ']) {
      assert.equal(parseDifficultyScaling(off), false, JSON.stringify(off));
    }
  });

  test('true (any case, trimmed) is on', () => {
    for (const on of ['true', 'TRUE', ' true ']) {
      assert.equal(parseDifficultyScaling(on), true, JSON.stringify(on));
    }
  });

  test('an unrecognized value throws — never a silent fall-back to off', () => {
    for (const bad of ['1', 'yes', 'on', 'no', 'abc']) {
      assert.throws(() => parseDifficultyScaling(bad), /Invalid DIFFICULTY_SCALING/, JSON.stringify(bad));
    }
  });
});

// The difficulty-only wiring seam (budget off): the difficulty proposal stands, unclamped by any spend.
describe('resolveDifficultyEffort — difficulty scaling with no budget cap', () => {
  const top5 = defaultEffortProfile({ roundCap: 5 });
  const smallDiff = [{ filename: 'a.js', patch: '@@ -1 +1 @@\n+x' }];        // churn 1
  const bigDiff = [{ filename: 'big.js', patch: '@@ -1 +1 @@\n' + '+x\n'.repeat(400) }];

  test('a trivial diff\'s proposal is returned unchanged (no budget to cap it below the ceiling)', () => {
    const candidates = difficultyCandidates(diff(3, { source: 1 }), top5); // ceiling roundCap 1
    const profile = resolveDifficultyEffort({ candidates, filteredFiles: smallDiff });
    assert.equal(profile.roundCap, 1);
  });

  test('a large diff keeps the full user ceiling — difficulty proposed it, no budget lowered it', () => {
    const candidates = difficultyCandidates(diff(400, { source: 6 }), top5); // full ladder up to 5
    const profile = resolveDifficultyEffort({ candidates, filteredFiles: bigDiff });
    assert.equal(profile.roundCap, 5);
  });
});

// [LAW:no-silent-failure] The round-cap skip message must name the lever that ACTUALLY bound, never one
// that was merely active — pointing a user at "raise the budget" when an easy diff (not the budget) set
// the cap sends them down the wrong path. This truth table locks the attribution: two levers, each
// credited only when it genuinely lowered the cap; `deRated` is exactly their union (never an empty
// lever list on a de-rated cap). defaultRoundCap 5 is the configured MAX_REVIEW_ROUNDS ceiling.
describe('bindingLevers — attribute a round-cap de-rate to the lever that bound', () => {
  const D = 5; // MAX_REVIEW_ROUNDS
  const at = (effortRoundCap, difficultyCeilingRoundCap) =>
    bindingLevers({ effortRoundCap, difficultyCeilingRoundCap, defaultRoundCap: D });

  test('no de-rate: the cap sits at the configured ceiling → no lever bound', () => {
    assert.deepEqual(at(5, 5), { deRated: false, budgetBound: false, difficultyBound: false });
  });

  test('difficulty alone: an easy diff lowered the ceiling, budget did not cap below it', () => {
    // difficulty proposed 2 (ceiling), effort landed at 2 (no budget lowering) → only difficulty bound.
    assert.deepEqual(at(2, 2), { deRated: true, budgetBound: false, difficultyBound: true });
  });

  test('budget alone: difficulty proposed the full ceiling, budget capped below it', () => {
    // difficulty ceiling 5 (substantial / difficulty off), budget capped to 2 → only budget bound.
    assert.deepEqual(at(2, 5), { deRated: true, budgetBound: true, difficultyBound: false });
  });

  test('both: difficulty lowered the ceiling AND budget capped further below it', () => {
    // difficulty proposed 3, budget capped to 1 → both bound.
    assert.deepEqual(at(1, 3), { deRated: true, budgetBound: true, difficultyBound: true });
  });

  test('the 0="unlimited" ceiling is de-rated to a finite cap → difficulty bound (ranks in effort space)', () => {
    // MAX_REVIEW_ROUNDS unlimited (0); difficulty proposed a finite ceiling 1 and effort landed there.
    const r = bindingLevers({ effortRoundCap: 1, difficultyCeilingRoundCap: 1, defaultRoundCap: 0 });
    assert.deepEqual(r, { deRated: true, budgetBound: false, difficultyBound: true });
  });

  test('deRated is exactly the union of the two binding levers (a full iff over valid states)', () => {
    // Forward (deRated ⇒ a lever bound) holds for ANY inputs: a de-rated cap never renders an empty
    // setters/remedies list. Reverse (a lever bound ⇒ deRated) holds under the PRODUCTION invariant
    // effort ≤ difficultyCeiling ≤ default (in effectiveRounds space, so 0=unlimited ranks as 8): effort
    // is chosen from a ladder whose ceiling is difficultyCeiling, which itself never exceeds the default —
    // so a bound lever never lands in the MAX_REVIEW_ROUNDS branch that would drop the lever names. The
    // iff is asserted over exactly that valid domain, per the transitivity the reviewer noted; a future
    // change letting effort exceed the ceiling would break the invariant and fail this assertion.
    for (let ceiling = 0; ceiling <= 5; ceiling++) {
      for (let effort = 0; effort <= 5; effort++) {
        const r = bindingLevers({ effortRoundCap: effort, difficultyCeilingRoundCap: ceiling, defaultRoundCap: 5 });
        if (r.deRated) assert.ok(r.budgetBound || r.difficultyBound, `empty levers at effort=${effort} ceiling=${ceiling}`);
        const valid = effectiveRounds(effort) <= effectiveRounds(ceiling) && effectiveRounds(ceiling) <= effectiveRounds(5);
        if (valid) assert.equal(r.deRated, r.budgetBound || r.difficultyBound, `iff broke at effort=${effort} ceiling=${ceiling}`);
      }
    }
  });
});
