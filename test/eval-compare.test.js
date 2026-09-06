'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseArgs, replayArgs, expectedMatcherLabel, estimateCandidateCostUsd,
  compareVerdict, renderVerdictMarkdown, resolveBaselineJsonPath, computeExpectedOpportunities,
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
  assert.equal(d.credentials, null);
  assert.equal(d.casesDir, 'eval/cases');
  assert.equal(d.cache, 'eval/out/.judge-cache.json');
  assert.equal(d.reuseCandidate, null);
  const o = parseArgs(['--baseline', 'b', '--matcher=lexical', '--out', 'o', '--credentials=A,B', '--cases-dir', 'c', '--cache=k']);
  assert.equal(o.baseline, 'b');
  assert.equal(o.matcher, 'lexical');
  assert.equal(o.out, 'o');
  assert.equal(o.credentials, 'A,B');
  assert.equal(o.casesDir, 'c');
  assert.equal(o.cache, 'k');
  assert.equal(parseArgs(['--reuse-candidate', 'r']).reuseCandidate, 'r');
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
  assert.throws(() => parseArgs(['--credentials=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--workers', '2']), /Unknown option: --workers/);
  // A flag that only shapes the replay contradicts --reuse-candidate, which replays nothing.
  assert.throws(() => parseArgs(['--out', 'o', '--reuse-candidate', 'r']), /--out and --reuse-candidate are mutually exclusive/);
  assert.throws(() => parseArgs(['--credentials', 'A,B', '--reuse-candidate', 'r']), /--credentials and --reuse-candidate are mutually exclusive/);
});

// ── replayArgs (what the replay step hands freeze-suite.js) ────────────────────────────────────────────
// The gate's two invariants live in these arguments: the BASELINE's case set and the BASELINE's N. A
// candidate replayed over a different set or depth measures a different population.

test('replayArgs pins the baseline case set and N, and forwards the lane roster verbatim', () => {
  const args = replayArgs({ repeats: 5, candidateRoot: '/c', casesDir: '/g', caseNames: ['b', 'a'], credentials: 'X,Y' });
  assert.deepEqual(args, ['-n', '5', '--out', '/c', '--cases-dir', '/g', '--cases', 'b,a', '--credentials', 'X,Y']);
});

test('replayArgs with no --credentials leaves lane selection to freeze-suite.js (its single-lane default)', () => {
  const args = replayArgs({ repeats: 2, candidateRoot: '/c', casesDir: '/g', caseNames: ['a'], credentials: null });
  assert.deepEqual(args, ['-n', '2', '--out', '/c', '--cases-dir', '/g', '--cases', 'a']);
  assert.ok(!args.includes('--credentials'));
});

// ── expectedMatcherLabel (the fast pre-check) ─────────────────────────────────────────────────────────

test('expectedMatcherLabel builds the exact label score.js records', () => {
  assert.equal(expectedMatcherLabel('lexical'), 'lexical');
  assert.equal(expectedMatcherLabel('llm'), `llm/${JUDGE_MODEL}`);
  assert.throws(() => expectedMatcherLabel('fuzzy'), /Unknown matcher kind/);
});

// ── estimateCandidateCostUsd (the cost guardrail) ─────────────────────────────────────────────────────

test('estimateCandidateCostUsd prices the full-suite passes still owed — fractional on an uneven resume — or null when uncosted', () => {
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: 0.6952 }, 5), 0.6952 * 5);
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: 0.6952 }, 9 / 4), 0.6952 * 9 / 4);
  assert.equal(estimateCandidateCostUsd({ costPerFullRunUsd: null }, 5), null);
  assert.equal(estimateCandidateCostUsd({}, 5), null);
  assert.equal(estimateCandidateCostUsd(null, 5), null);
});

// ── computeExpectedOpportunities (the pre-loop opportunities-guard arithmetic) ────────────────────────

test('computeExpectedOpportunities sums per-case must-find counts and multiplies by the repeat count', () => {
  assert.equal(computeExpectedOpportunities({ 'case-a': 3, 'case-b': 3 }, 2), 12);
  assert.equal(computeExpectedOpportunities({ 'case-a': 5 }, 1), 5);
  assert.equal(computeExpectedOpportunities({}, 5), 0); // no cases ⇒ no opportunities, regardless of N
  assert.equal(computeExpectedOpportunities({ 'case-a': 0, 'case-b': 4 }, 3), 12); // a case with zero must-finds contributes zero, not skipped
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
    candidate: { sha: 'cafe1234', dirty: true }, baselineSha: 'basesha0deadbeef',
    cost: { baselinePerRun: 0.7, candidatePerRun: 0.5, delta: -0.2 },
  });
  assert.match(md, /## Eval verdict — 🔴 DEGRADED/);
  assert.match(md, /PRIMARY GATE — pooled inventory must-find recall/);
  assert.match(md, /Candidate \(a dirty tree at commit cafe123\) vs baseline/);
  assert.match(renderVerdictMarkdown(v, { candidate: { sha: 'cafe1234', dirty: false }, baselineSha: 'basesha0deadbeef', cost: null }), /Candidate \(commit cafe123\) vs baseline/);
  assert.match(renderVerdictMarkdown(v, { candidate: null, baselineSha: 'basesha0deadbeef', cost: null }), /Candidate \(no recorded identity/);
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

// ── resolveBaselineJsonPath (effect code — a real temp git repo, not a pure-core fixture) ──────────────
//
// This function has been rewritten three times across review rounds (bare name sort → generatedAt
// tie-break → git-commit-time tie-break), each prior version wrong in a different, subtle way. A real
// integration test against actual git history is what a mocked/pure fixture cannot catch — the whole bug
// class is "does this correctly read real git state," which a fixture can only assert the code CLAIMS to
// do. gitCwd is a seam specifically so this can point git at a disposable temp repo instead of asserting
// against (or fabricating commits into) this repo's own history.

function withTempGitRepo(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-'));
  const prevCwd = process.cwd();
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    process.chdir(tmp);
    fn(tmp);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeBaselineDir(tmp, dirName) {
  const dir = path.join(tmp, 'eval', 'baseline', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ marker: dirName }));
  return dir;
}

function commitAll(tmp, message) {
  execFileSync('git', ['add', '-A'], { cwd: tmp });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: tmp });
}

test('resolveBaselineJsonPath tie-breaks a same-date pair by actual commit order, not directory name', () => {
  withTempGitRepo((tmp) => {
    // Same date prefix on both — a bare name sort OR a generatedAt tie-break (which carries the identical
    // date string) would pick whichever name sorts last ('zzz...' > 'aaa...'), regardless of which was
    // actually frozen more recently. Committing 'aaa' SECOND (chronologically later) while it sorts FIRST
    // by name proves the picked winner comes from real commit order, not the name.
    writeBaselineDir(tmp, '2026-08-01-zzz9999');
    commitAll(tmp, 'freeze zzz (first, older)');
    writeBaselineDir(tmp, '2026-08-01-aaa1111');
    commitAll(tmp, 'freeze aaa (second, newer)');

    const picked = resolveBaselineJsonPath(null, tmp);
    assert.match(picked, /2026-08-01-aaa1111/);
  });
});

test('resolveBaselineJsonPath picks an uncommitted baseline over any committed one — freshly frozen, not yet committed, is the newest', () => {
  withTempGitRepo((tmp) => {
    writeBaselineDir(tmp, '2026-08-09-committed');
    commitAll(tmp, 'freeze, committed');
    // Written to disk but never committed — the exact "just ran eval/baseline.js, about to gate against
    // it" moment. Its name looks OLDER than the committed one to prove the win comes from being
    // uncommitted, not from the name.
    writeBaselineDir(tmp, '2020-01-01-uncommitted');

    const picked = resolveBaselineJsonPath(null, tmp);
    assert.match(picked, /2020-01-01-uncommitted/);
  });
});

test('resolveBaselineJsonPath refuses to pick among multiple baselines in a shallow clone — no real history to rank them by', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-first');
    commitAll(source, 'freeze first');
    writeBaselineDir(source, '2026-08-02-second');
    commitAll(source, 'freeze second');

    // A shallow clone (actions/checkout's default fetch-depth: 1) sees only the single checked-out commit —
    // commitOrder has nothing to rank either baseline.json against.
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      assert.throws(() => resolveBaselineJsonPath(null, shallow), /shallow git clone/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

test('resolveBaselineJsonPath does NOT refuse a shallow clone with only one baseline — nothing to tie-break', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-only');
    commitAll(source, 'freeze only');

    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      const picked = resolveBaselineJsonPath(null, shallow);
      assert.match(picked, /2026-08-01-only/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

test('resolveBaselineJsonPath does NOT refuse a shallow clone with an uncommitted baseline alongside committed ones — the uncommitted one already wins outright, nothing ambiguous', () => {
  withTempGitRepo((source) => {
    writeBaselineDir(source, '2026-08-01-committed-a');
    commitAll(source, 'freeze a');
    writeBaselineDir(source, '2026-08-02-committed-b');
    commitAll(source, 'freeze b');

    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-baseline-shallow-'));
    const prevCwd = process.cwd();
    try {
      execFileSync('git', ['clone', '--depth', '1', `file://${source}`, shallow], { stdio: 'ignore' });
      process.chdir(shallow);
      // The two committed baselines are indistinguishable in this shallow clone (git reports the same
      // boundary commit as the last to touch both) — but this uncommitted one is unconditionally newer
      // than either, so the pick is NOT ambiguous despite there being three candidate dirs in a shallow
      // clone. A blunt "more than one dir in a shallow clone ⇒ refuse" rule would wrongly refuse this.
      writeBaselineDir(shallow, '2020-01-01-uncommitted');
      const picked = resolveBaselineJsonPath(null, shallow);
      assert.match(picked, /2020-01-01-uncommitted/);
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(shallow, { recursive: true, force: true });
    }
  });
});

// ── resume or refuse: prior runs under --out against the tree under gate ──────────────────────────────
const { foreignRuns, readPriorRuns, deficitReplays, excessRuns, driftedRuns, producedTree } = require('../eval/compare');

test('foreignRuns keeps the runs replayed on this exact clean commit and names every other by both trees', () => {
  const here = { sha: 'aaaaaaa1', dirty: false };
  const runs = [
    { dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } },   // ours
    { dir: 'r2', candidate: { sha: 'bbbbbbb2', dirty: false } },   // another commit
    { dir: 'r3', candidate: { sha: 'aaaaaaa1', dirty: true } },    // same commit, dirty when replayed
    { dir: 'r4', candidate: null },                                // pre-provenance run
  ];
  const foreign = foreignRuns(here, runs);
  assert.deepEqual(foreign.map(f => f.dir), ['r2', 'r3', 'r4']);
  assert.match(foreign[0].reason, /replayed on commit bbbbbbb; the tree under gate is commit aaaaaaa/);
  assert.match(foreign[1].reason, /a dirty tree at commit aaaaaaa/);
  assert.match(foreign[2].reason, /no recorded identity/);
});

test('foreignRuns under a dirty tree refuses EVERY prior run — nothing can be proven its own', () => {
  const ours = [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } }];
  const dirty = foreignRuns({ sha: 'aaaaaaa1', dirty: true }, ours);
  assert.equal(dirty.length, 1);
  assert.match(dirty[0].reason, /the tree under gate is a dirty tree at commit aaaaaaa/);
  assert.deepEqual(foreignRuns({ sha: 'aaaaaaa1', dirty: true }, []), []);
});

test('deficitReplays is the census arithmetic: per case, the shortfall to N over the accepted prior runs', () => {
  const prior = [{ case: 'a' }, { case: 'a' }, { case: 'a' }, { case: 'b' }, { case: 'c' }, { case: 'c' }, { case: 'c' }, { case: 'c' }, { case: 'c' }];
  assert.equal(deficitReplays(['a', 'b', 'c', 'd'], prior, 5), 2 + 4 + 0 + 5);
  assert.equal(deficitReplays(['a', 'b'], [], 5), 10);
});

test('excessRuns names every case holding more runs than N — the population the gate cannot measure', () => {
  const prior = [{ case: 'a' }, { case: 'a' }, { case: 'a' }, { case: 'c' }, { case: 'c' }];
  assert.deepEqual(excessRuns(['a', 'b', 'c'], prior, 2), [{ case: 'a', completed: 3 }]);
  assert.deepEqual(excessRuns(['a', 'b', 'c'], prior, 3), []);
});

test('driftedRuns compares the recorded tree to the snapshot by equality — a dirty tree\'s own fresh runs are NOT drift', () => {
  const dirty = { sha: 'aaaaaaa1', dirty: true };
  const clean = { sha: 'aaaaaaa1', dirty: false };
  assert.deepEqual(driftedRuns(dirty, [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: true } }]), []);
  assert.deepEqual(driftedRuns(clean, [{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } }]), []);
  const moved = driftedRuns(clean, [
    { dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: false } },
    { dir: 'r2', candidate: { sha: 'aaaaaaa1', dirty: true } },   // edited mid-run
    { dir: 'r3', candidate: { sha: 'bbbbbbb2', dirty: false } },  // committed mid-run
    { dir: 'r4', candidate: null },
  ]);
  assert.deepEqual(moved.map(m => m.dir), ['r2', 'r3', 'r4']);
  assert.match(moved[0].reason, /recorded a dirty tree at commit aaaaaaa; the tree snapshotted before the replay was commit aaaaaaa/);
});

test('producedTree names the one tree every run records — the verdict\'s provenance comes from the runs, not the checkout', () => {
  const clean = { sha: 'aaaaaaa1', dirty: false };
  assert.deepEqual(producedTree([{ dir: 'r1', candidate: clean }, { dir: 'r2', candidate: { sha: 'aaaaaaa1', dirty: false } }]), clean);
  assert.deepEqual(producedTree([{ dir: 'r1', candidate: { sha: 'aaaaaaa1', dirty: true } }]), { sha: 'aaaaaaa1', dirty: true });
  // Pre-provenance runs agree with each other on having no identity, and the verdict says so; a reused
  // root of summaries alone (no run dirs) has none to name either.
  assert.equal(producedTree([{ dir: 'r1', candidate: null }, { dir: 'r2', candidate: null }]), null);
  assert.equal(producedTree([]), null);
  assert.throws(() => producedTree([
    { dir: 'r1', candidate: clean },
    { dir: 'r2', candidate: { sha: 'bbbbbbb2', dirty: false } },
    { dir: 'r3', candidate: null },
  ]), /not produced by one tree:\n {2}r2 recorded commit bbbbbbb; r1 recorded commit aaaaaaa\n {2}r3 recorded no recorded identity/);
});

test('readPriorRuns reads the census the replay will take — completed runs only, each with its recorded tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-prior-'));
  try {
    const mk = (caseName, run, meta, complete = true) => {
      const dir = path.join(root, caseName, run);
      fs.mkdirSync(dir, { recursive: true });
      if (complete) fs.writeFileSync(path.join(dir, 'findings.json'), '[]\n');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ case: caseName, ...meta }) + '\n');
      return dir;
    };
    const a1 = mk('case-a', '2026-01-01T00-00-00-000Z-run1', { candidate: { sha: 'abc', dirty: false } });
    const a2 = mk('case-a', '2026-01-01T00-00-01-000Z-run1', {});
    mk('case-a', '2026-01-01T00-00-02-000Z-run1', { candidate: { sha: 'abc', dirty: false } }, false); // crashed: no findings.json
    mk('case-c', '2026-01-01T00-00-03-000Z-run1', { candidate: { sha: 'abc', dirty: false } });       // not a gated case
    const prior = readPriorRuns(root, ['case-a', 'case-b']);
    const misplaced = path.join(root, 'case-b', '2026-01-01T00-00-04-000Z-run1');
    fs.mkdirSync(misplaced, { recursive: true });
    fs.writeFileSync(path.join(misplaced, 'findings.json'), '[]\n');
    fs.writeFileSync(path.join(misplaced, 'meta.json'), JSON.stringify({ case: 'case-a', candidate: { sha: 'abc', dirty: false } }) + '\n');
    assert.throws(() => readPriorRuns(root, ['case-a', 'case-b']), /names case 'case-a' but lives under 'case-b'/);
    fs.rmSync(misplaced, { recursive: true, force: true });
    assert.deepEqual(prior, [
      { case: 'case-a', dir: a1, candidate: { sha: 'abc', dirty: false } },
      { case: 'case-a', dir: a2, candidate: null },
    ]);
    assert.deepEqual(readPriorRuns(path.join(root, 'absent'), ['case-a']), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
