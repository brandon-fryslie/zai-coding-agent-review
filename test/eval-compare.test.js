'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs, parsePositiveInt, expectedMatcherLabel, estimateCandidateCostUsd,
  compareVerdict, renderVerdictMarkdown,
} = require('../eval/compare');
const { buildBaseline, parseBaseline } = require('../eval/baseline');
const { JUDGE_MODEL } = require('../eval/score');

// [LAW:verifiable-goals] AC: compare.js gates a candidate suite against a frozen baseline and emits a
// DEGRADED/OK/IMPROVED verdict (non-zero exit on DEGRADED). These tests exercise the PURE core — arg parse,
// the matcher-label pre-check, the cost estimate, the comparison, the rendering — with in-memory fixtures.
// No IO, no spawn. [LAW:behavior-not-structure] They assert the gate contract, not internals.

// A candidate SUITE is exactly buildBaseline's output — build fixtures through it so the test can't drift
// from the real reducer. Each case pools its perRun must-finds. `caseEntry` mirrors eval-baseline.test.js:
// the gate reads the INVENTORY band/fractions (the primary gate since the pooled-inventory refactor), so
// each perRun entry carries both the frozen-round and inventory fractions — here identical (no extra
// inventory rounds), matching a case with a single frozen round.
function caseEntry(name, mustFindBand, perRun, engine) {
  return {
    summary: {
      case: name, runs: perRun.length, matcher: 'llm/deepseek-v4-flash',
      mustFindRecall: mustFindBand,
      inventoryMustFindRecall: mustFindBand,
      niceToFindRecall: { mean: 0, min: 0, max: 0, n: perRun.length },
      inventoryNiceToFindRecall: { mean: 0, min: 0, max: 0, n: perRun.length },
      noiseCount: { mean: 1, min: 0, max: 2, n: perRun.length },
      costUsd: { mean: 0.2, min: 0.1, max: 0.3, n: perRun.length },
      perRun: perRun.map(([found, total], i) => ({
        mustFind: { found, total }, inventoryMustFind: { found, total }, costUsd: 0.1 + i * 0.05,
      })),
    },
    engine: engine ?? { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  };
}

// A frozen baseline (parseBaseline output) built from the SAME reducer, then loaded — so baseline and
// candidate share one producer, exactly as production does.
function frozenBaseline(cases, provenance = { sha: 'basesha0', date: '2026-08-01' }) {
  return parseBaseline(JSON.stringify(buildBaseline({ cases, provenance })), 'baseline.json');
}
function candidateSuite(cases, provenance = { sha: 'candsha0', date: '2026-08-02' }) {
  return buildBaseline({ cases, provenance });
}

// A shared two-case shape: pooled 3/6 across each ⇒ suite 6/12 = 0.5, gate floor ≈ 0.22 (2σ under 0.5).
const CASES_A = () => [
  caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
  caseEntry('case-b', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
];

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs applies defaults and honors flags', () => {
  const d = parseArgs([]);
  assert.equal(d.baseline, null);
  assert.equal(d.matcher, 'llm');
  assert.equal(d.out, null);
  assert.equal(d.workers, 4);
  assert.equal(d.casesDir, 'eval/cases');
  assert.equal(d.cache, 'eval/out/.judge-cache.json');
  assert.equal(d.reuseCandidate, null);
  const o = parseArgs(['--baseline', 'b', '--matcher=lexical', '--out', 'o', '--workers=2', '--cases-dir', 'c', '--cache=k', '--reuse-candidate', 'r']);
  assert.equal(o.baseline, 'b');
  assert.equal(o.matcher, 'lexical');
  assert.equal(o.out, 'o');
  assert.equal(o.workers, 2);
  assert.equal(o.casesDir, 'c');
  assert.equal(o.cache, 'k');
  assert.equal(o.reuseCandidate, 'r');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['--baseline']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--baseline', '--matcher=llm']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--out=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--matcher', 'fuzzy']), /--matcher must be 'llm' or 'lexical'/);
  assert.throws(() => parseArgs(['--workers', '2.5']), /--workers must be a positive integer/);
  assert.throws(() => parseArgs(['--workers', '0']), /--workers must be a positive integer/);
});

test('parsePositiveInt rejects non-integers and echoes the value', () => {
  assert.equal(parsePositiveInt('3', '--x'), 3);
  assert.throws(() => parsePositiveInt('3.7', '--x'), /"3.7"/);
  assert.throws(() => parsePositiveInt('-1', '--x'), /positive integer/);
});

// ── expectedMatcherLabel (the fast pre-check) ─────────────────────────────────────────────────────────

test('expectedMatcherLabel builds the exact label score.js records', () => {
  assert.equal(expectedMatcherLabel('lexical'), 'lexical');
  assert.equal(expectedMatcherLabel('llm'), `llm/${JUDGE_MODEL}`);
  assert.throws(() => expectedMatcherLabel('fuzzy'), /Unknown matcher kind/);
});

// ── estimateCandidateCostUsd (the cost guardrail) ─────────────────────────────────────────────────────

test('estimateCandidateCostUsd multiplies the baseline per-run cost by N, or null when absent', () => {
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: 0.6952 }, 5), 0.6952 * 5);
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: null }, 5), null);
  assert.equal(estimateCandidateCostUsd({}, 5), null);
  assert.equal(estimateCandidateCostUsd(null, 5), null);
});

// ── compareVerdict (THE GATE) ─────────────────────────────────────────────────────────────────────────

test('compareVerdict returns OK when the candidate clears the floor at the baseline rate', () => {
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite(CASES_A());
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, false);
  assert.equal(v.status, 'OK'); // identical rate ⇒ not > baseline ⇒ OK, not IMPROVED
  assert.equal(v.pooled.candidate.rate, 0.5);
  assert.equal(v.pooled.baseline.rate, 0.5);
  assert.equal(v.movedCases.length, 0);
  assert.equal(v.cases.length, 2);
  assert.equal(v.cases[0].delta, 0);
});

test('compareVerdict flags DEGRADED and localizes the moved case when the candidate falls below the floor', () => {
  const baseline = frozenBaseline(CASES_A()); // rate 0.5, floor ≈ 0.22
  // Candidate finds nothing on either case ⇒ pooled 0/12 = 0 < floor.
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
    caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, true);
  assert.equal(v.status, 'DEGRADED');
  assert.equal(v.pooled.candidate.rate, 0);
  // Both candidate means (0) are below the baseline diagnostic floor (0.3333) ⇒ both localized.
  assert.deepEqual(v.movedCases.sort(), ['case-a', 'case-b']);
});

test('compareVerdict reports IMPROVED (informational) when the candidate exceeds the baseline rate', () => {
  const baseline = frozenBaseline(CASES_A()); // 0.5
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 1, min: 1, max: 1, n: 2 }, [[3, 3], [3, 3]]),
    caseEntry('case-b', { mean: 1, min: 1, max: 1, n: 2 }, [[3, 3], [3, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  assert.equal(v.degraded, false);
  assert.equal(v.status, 'IMPROVED');
  assert.equal(v.pooled.candidate.rate, 1);
});

test('compareVerdict treats a candidate exactly AT the floor as OK (strictly-less gate)', () => {
  const baseline = frozenBaseline(CASES_A());
  const floor = baseline.pooledInventoryMustFind.gateFloor; // rounded to ≤4 decimal places by buildBaseline
  // Drive the boundary through TRUE equality with the fraction evaluateGate actually compares
  // (found/opportunities), not an approximation. opportunities=10000 guarantees floor*opportunities is an
  // integer (floor has ≤4 decimal digits), so found/opportunities reproduces floor exactly — unlike a
  // Math.ceil()-rounded found, which lands strictly ABOVE the floor and never exercises true equality despite
  // a test name/comment claiming it does. Also override baseline's own opportunities to the same value, so
  // this construction still satisfies compareVerdict's candidate/baseline pooled-opportunities-match check.
  const opportunities = 10000;
  const found = Math.round(floor * opportunities);
  assert.equal(found / opportunities, floor); // sanity: exact equality, not merely close
  baseline.pooledInventoryMustFind.opportunities = opportunities;

  const atFloor = candidateSuite(CASES_A());
  atFloor.suite.pooledInventoryMustFind.found = found;
  atFloor.suite.pooledInventoryMustFind.opportunities = opportunities;
  atFloor.suite.pooledInventoryMustFind.rate = found / opportunities;
  assert.equal(compareVerdict(baseline, atFloor).degraded, false);

  const below = candidateSuite(CASES_A());
  below.suite.pooledInventoryMustFind.found = found - 1;
  below.suite.pooledInventoryMustFind.opportunities = opportunities;
  below.suite.pooledInventoryMustFind.rate = (found - 1) / opportunities;
  assert.equal(compareVerdict(baseline, below).degraded, true);
});

test('compareVerdict refuses incomparable N / engine / matcher / case set', () => {
  const baseline = frozenBaseline(CASES_A());
  // Mismatched N (candidate cases each have 3 runs).
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 3 }, [[1, 3], [1, 3], [1, 3]]),
    caseEntry('case-b', { mean: 0.5, min: 0.5, max: 0.5, n: 3 }, [[1, 3], [1, 3], [1, 3]]),
  ])), /Incomparable: candidate ran at N=3 but the baseline is N=2/);
  // Mismatched engine.
  const zai = { provider: 'zai', model: 'glm', reasoning: null };
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]], zai),
    caseEntry('case-b', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]], zai),
  ])), /Incomparable: candidate ran on engine/);
  // Missing a case + an extra case.
  assert.throws(() => compareVerdict(baseline, candidateSuite([
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
    caseEntry('case-c', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]),
  ])), /Incomparable case sets.*missing \[case-b\].*extra \[case-c\]/s);
});

test('compareVerdict refuses a candidate whose pooled inventory opportunities differ from the baseline', () => {
  // expected.json is a living document (curated independent of re-freezing); if a case's inventory changed
  // opportunity count since the baseline was frozen, the candidate's pooled denominator no longer matches
  // what the gate floor was computed from — an apples-to-oranges verdict this check refuses.
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite(CASES_A());
  candidate.suite.pooledInventoryMustFind.opportunities += 1; // simulate expected.json gaining a must-find
  assert.throws(() => compareVerdict(baseline, candidate),
    /Incomparable: candidate's pooled inventory opportunities \(13\) differ from the baseline's \(12\)/);
});

test('compareVerdict matcher mismatch is refused', () => {
  const baseline = frozenBaseline(CASES_A());
  const lexicalCase = (name) => {
    const c = caseEntry(name, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }, [[1, 3], [2, 3]]);
    c.summary.matcher = 'lexical';
    return c;
  };
  assert.throws(() => compareVerdict(baseline, candidateSuite([lexicalCase('case-a'), lexicalCase('case-b')])),
    /Incomparable: candidate was scored with matcher 'lexical'/);
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────

test('renderVerdictMarkdown surfaces the gate, the per-case table, cost, and a final verdict line', () => {
  const baseline = frozenBaseline(CASES_A());
  const candidate = candidateSuite([
    caseEntry('case-a', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
    caseEntry('case-b', { mean: 0, min: 0, max: 0, n: 2 }, [[0, 3], [0, 3]]),
  ]);
  const v = compareVerdict(baseline, candidate);
  const md = renderVerdictMarkdown(v, {
    candidateSha: 'cafe123', dirty: true, baselineSha: 'basesha0deadbeef',
    cost: { baselinePerRun: 0.7, candidatePerRun: 0.5, delta: -0.2 },
  });
  assert.match(md, /## Eval verdict — 🔴 DEGRADED/);
  assert.match(md, /PRIMARY GATE — pooled inventory must-find recall/);
  assert.match(md, /working tree `cafe123`, dirty/);
  assert.match(md, /\| `case-a` \|/);
  assert.match(md, /⚠️ yes/);
  assert.match(md, /\*\*Cost:\*\*/);
  assert.match(md, /\*\*VERDICT: DEGRADED\*\*/);
  assert.match(md, /Localized to: `case-a`, `case-b`/);
});

test('renderVerdictMarkdown OK path names no cases and reads clean', () => {
  const baseline = frozenBaseline(CASES_A());
  const md = renderVerdictMarkdown(compareVerdict(baseline, candidateSuite(CASES_A())), { baselineSha: 'basesha0' });
  assert.match(md, /## Eval verdict — 🟢 OK/);
  assert.match(md, /\*\*VERDICT: OK\*\*/);
  assert.doesNotMatch(md, /Localized to/);
});
