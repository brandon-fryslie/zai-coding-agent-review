'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs, parseBand, parseCaseSummary, parseCaseEngine, parseFraction,
  sameEngine, pooledFloor, buildBaseline, parseBaseline, renderBaselineMarkdown, DEGRADATION_RULE,
} = require('../eval/baseline');

// [LAW:verifiable-goals] AC: baseline.js reduces the golden cases' scored summaries into one frozen
// distribution + a degradation rule. These tests exercise the PURE core (arg parse, input parsers, the
// reduction, the loader) with in-memory fixtures — no IO. [LAW:behavior-not-structure] They assert the
// frozen contract (the shape 2fk.5 loads + the consistency gates), not internals.

// A realistic scorecard-summary.json (score.js's aggregateRuns output), N=2.
function summaryFixture(overrides = {}) {
  return JSON.stringify({
    case: 'case-a', runs: 2, matcher: 'llm/deepseek-v4-flash',
    mustFindRecall: { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 },
    niceToFindRecall: { mean: 0.25, min: 0, max: 0.5, n: 2 },
    noiseCount: { mean: 1, min: 0, max: 2, n: 2 },
    costUsd: { mean: 0.2, min: 0.18, max: 0.22, n: 2 },
    perRun: [
      { mustFind: '1/3', niceToFind: '0/2', noise: 0, costUsd: 0.18 },
      { mustFind: '2/3', niceToFind: '1/2', noise: 2, costUsd: 0.22 },
    ],
    ...overrides,
  });
}

const ENGINE = JSON.stringify({ name: 'case-a', engine: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null } });

// A parsed {summary, engine} case entry buildBaseline consumes. perRun.mustFind is the TYPED {found,total}
// parseCaseSummary produces at the boundary (buildBaseline no longer parses strings).
function caseEntry(name, mustFindBand, opts = {}) {
  return {
    summary: {
      case: name, runs: opts.runs ?? 2, matcher: opts.matcher ?? 'llm/deepseek-v4-flash',
      mustFindRecall: mustFindBand,
      niceToFindRecall: { mean: 0, min: 0, max: 0, n: 2 },
      noiseCount: { mean: 1, min: 0, max: 2, n: 2 },
      costUsd: { mean: 0.2, min: 0.1, max: 0.3, n: 2 },
      perRun: opts.perRun ?? [{ mustFind: { found: 1, total: 3 }, costUsd: 0.1 }, { mustFind: { found: 2, total: 3 }, costUsd: 0.3 }],
    },
    engine: opts.engine ?? { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  };
}

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs applies defaults and honors flags', () => {
  const d = parseArgs([]);
  assert.equal(d.outDir, 'eval/out');
  assert.equal(d.casesDir, 'eval/cases');
  assert.equal(d.dest, 'eval/baseline');
  assert.equal(d.sha, null);
  assert.equal(d.date, null);
  const o = parseArgs(['--out-dir', 'o', '--cases-dir=c', '--dest', 'd', '--sha', 'abc123', '--date=2026-08-01']);
  assert.deepEqual(o, { outDir: 'o', casesDir: 'c', dest: 'd', sha: 'abc123', date: '2026-08-01' });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['--sha']), /requires a non-empty value/);
  // A --prefixed value is a swallowed flag, not the argument.
  assert.throws(() => parseArgs(['--sha', '--date=x']), /requires a non-empty value/);
  // An empty value (=form or space-form) is rejected, not resolved to cwd downstream.
  assert.throws(() => parseArgs(['--out-dir=']), /requires a non-empty value/);
  assert.throws(() => parseArgs(['--out-dir', '']), /requires a non-empty value/);
});

// ── parseBand ──────────────────────────────────────────────────────────────────────────────────────

test('parseBand accepts numbers-or-null and a non-negative n; rejects the rest', () => {
  assert.deepEqual(parseBand({ mean: 0.5, min: 0.3, max: 0.7, n: 2 }, 'b'), { mean: 0.5, min: 0.3, max: 0.7, n: 2 });
  assert.deepEqual(parseBand({ mean: null, min: null, max: null, n: 0 }, 'b'), { mean: null, min: null, max: null, n: 0 });
  assert.throws(() => parseBand(null, 'b'), /not a band object/);
  assert.throws(() => parseBand([], 'b'), /not a band object/);
  assert.throws(() => parseBand({ mean: 'x', min: 0, max: 0, n: 1 }, 'b'), /mean must be a finite number or null/);
  assert.throws(() => parseBand({ mean: Infinity, min: 0, max: 0, n: 1 }, 'b'), /finite number or null/);
  assert.throws(() => parseBand({ mean: 0, min: 0, max: 0, n: -1 }, 'b'), /n must be a non-negative integer/);
  assert.throws(() => parseBand({ mean: 0, min: 0, max: 0, n: 1.5 }, 'b'), /n must be a non-negative integer/);
});

// ── parseCaseSummary ─────────────────────────────────────────────────────────────────────────────────

test('parseCaseSummary keeps the reduced fields and rejects malformed summaries', () => {
  const s = parseCaseSummary(summaryFixture(), 'sum.json');
  assert.equal(s.case, 'case-a');
  assert.equal(s.runs, 2);
  assert.equal(s.matcher, 'llm/deepseek-v4-flash');
  assert.deepEqual(s.mustFindRecall, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 });
  assert.equal(s.perRun.length, 2);
  assert.equal(s.perRun[0].costUsd, 0.18);
  // mustFind is parsed to a typed {found,total} at the boundary, not kept as a raw string.
  assert.deepEqual(s.perRun[0].mustFind, { found: 1, total: 3 });
  // Valid-but-wrong-typed JSON is rejected at the shared object boundary.
  assert.throws(() => parseCaseSummary('123', 'x'), /not a JSON object/);
  assert.throws(() => parseCaseSummary(summaryFixture({ case: '' }), 'x'), /no 'case' name/);
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 0 }), 'x'), /'runs' must be a positive integer/);
  assert.throws(() => parseCaseSummary(summaryFixture({ matcher: '' }), 'x'), /no 'matcher'/);
  assert.throws(() => parseCaseSummary(summaryFixture({ perRun: 'x' }), 'x'), /no 'perRun' array/);
  assert.throws(() => parseCaseSummary(summaryFixture({ mustFindRecall: { mean: 1 } }), 'x'), /mustFindRecall.*non-negative integer/s);
  // perRun length must agree with `runs` — a desync would silently pool the wrong total.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 3 }), 'x'), /2 perRun entries but claims runs=3/);
  // A perRun entry with an absent or non-string mustFind is rejected at the boundary (never leaks a null
  // into the reduction). Length is kept at 1 so the mustFind check — not the length check — fires.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ costUsd: 0.1 }] }), 'x'), /mustFind must be a 'found\/total' string/);
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: 5 }] }), 'x'), /mustFind must be a 'found\/total' string/);
  // A mustFind string that isn't a fraction is rejected too (parseFraction at the boundary).
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: 'n/a' }] }), 'x'), /not a 'found\/total' fraction/);
  // A non-numeric perRun cost is a corrupt summary, not a silent null.
  assert.throws(() => parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '1/3', costUsd: 'free' }] }), 'x'), /perRun\[0\]\.costUsd/);
});

test('parseCaseSummary treats an absent perRun cost as null (cost unavailable that run)', () => {
  const s = parseCaseSummary(summaryFixture({ runs: 1, perRun: [{ mustFind: '1/3' }] }), 'x');
  assert.deepEqual(s.perRun[0].mustFind, { found: 1, total: 3 });
  assert.equal(s.perRun[0].costUsd, null);
});

// ── parseCaseEngine ──────────────────────────────────────────────────────────────────────────────────

test('parseCaseEngine reads the pinned engine and normalizes absent reasoning to null', () => {
  assert.deepEqual(parseCaseEngine(ENGINE, 'c'), { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.throws(() => parseCaseEngine('{}', 'c'), /no 'engine' object/);
  assert.throws(() => parseCaseEngine(JSON.stringify({ engine: { model: 'm' } }), 'c'), /engine.provider is missing/);
  assert.throws(() => parseCaseEngine(JSON.stringify({ engine: { provider: 'p' } }), 'c'), /engine.model is missing/);
});

// ── sameEngine ───────────────────────────────────────────────────────────────────────────────────────

test('sameEngine compares every pin field, treating absent reasoning as null', () => {
  const base = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null };
  assert.equal(sameEngine(base, { ...base }), true);
  assert.equal(sameEngine(base, { provider: 'deepseek', model: 'deepseek-v4-pro' }), true);
  assert.equal(sameEngine(base, { ...base, model: 'other' }), false);
  assert.equal(sameEngine(base, { ...base, reasoning: 'high' }), false);
});

// ── buildBaseline (the reduction) ──────────────────────────────────────────────────────────────────

test('buildBaseline freezes diagnostic bands, the pooled gate, suite cost, and the rule', () => {
  const cases = [
    caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 }),
    caseEntry('case-b', { mean: 1, min: 1, max: 1, n: 2 }),
  ];
  const b = buildBaseline({ cases, provenance: { sha: 'deadbeefcafe', date: '2026-08-01' } });
  assert.equal(b.schema, 'copirate-eval-baseline/v1');
  assert.equal(b.mainSha, 'deadbeefcafe');
  assert.equal(b.generatedAt, '2026-08-01');
  assert.equal(b.repeats, 2);
  assert.equal(b.matcher, 'llm/deepseek-v4-flash');
  assert.deepEqual(b.engine, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.deepEqual(b.degradationRule, DEGRADATION_RULE);
  // Per-case DIAGNOSTIC floor = the case's observed min must-find recall (not the gate).
  assert.equal(b.cases[0].diagnosticFloor, 0.3333);
  assert.equal(b.cases[1].diagnosticFloor, 1);
  assert.deepEqual(b.cases[0].perRun, ['1/3', '2/3']);
  // PRIMARY GATE: pooled across every run of every case. Both cases run perRun ['1/3','2/3'] ⇒ each pools
  // 3 found / 6 opportunities; two cases ⇒ 6/12 = 0.5, with a ~2σ lower bound as the gate floor.
  assert.equal(b.suite.pooledMustFind.found, 6);
  assert.equal(b.suite.pooledMustFind.opportunities, 12);
  assert.equal(b.suite.pooledMustFind.rate, 0.5);
  // Stored gate floor is the ~2σ lower bound, rounded to 4dp.
  assert.equal(b.suite.pooledMustFind.gateFloor, Math.round(pooledFloor(6, 12) * 1e4) / 1e4);
  assert.ok(b.suite.pooledMustFind.gateFloor < 0.5 && b.suite.pooledMustFind.gateFloor > 0);
  // Suite cost = sum of every run's cost across cases; per-full-run = total / N.
  assert.equal(b.suite.cases, 2);
  assert.equal(b.suite.totalCostUsd, 0.8); // (0.1+0.3) + (0.1+0.3)
  assert.equal(b.suite.costPerFullRunUsd, 0.4);
  assert.equal(b.suite.costedRuns, 4);
  assert.equal(b.suite.uncostedRuns, 0);
  // Informational headline recall = unweighted mean of case means.
  assert.equal(b.suite.meanMustFindRecall, 0.75);
});

test('parseFraction reads found/total and rejects non-fractions', () => {
  assert.deepEqual(parseFraction('1/7', 'x'), { found: 1, total: 7 });
  assert.deepEqual(parseFraction('0/0', 'x'), { found: 0, total: 0 });
  assert.throws(() => parseFraction('n/a', 'x'), /not a 'found\/total' fraction/);
  assert.throws(() => parseFraction('1.5/3', 'x'), /not a 'found\/total' fraction/);
  assert.throws(() => parseFraction('5/3', 'x'), /found > total/);
});

test('pooledFloor is a ~2σ binomial lower bound in [0, rate)', () => {
  const f = pooledFloor(14, 75); // the real baseline shape
  assert.ok(f > 0 && f < 14 / 75);
  assert.equal(pooledFloor(0, 0), null); // no opportunities → no floor
  assert.equal(pooledFloor(10, 10), 1);  // p=1 ⇒ se=0 ⇒ floor=1
});

test('buildBaseline counts uncosted runs and excludes them from the total', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 1 }, {
    perRun: [{ mustFind: { found: 1, total: 2 }, costUsd: 0.15 }, { mustFind: { found: 1, total: 2 }, costUsd: null }],
  })];
  const b = buildBaseline({ cases, provenance: { sha: 'abc', date: '2026-08-01' } });
  assert.equal(b.suite.totalCostUsd, 0.15);
  assert.equal(b.suite.costedRuns, 1);
  assert.equal(b.suite.uncostedRuns, 1);
  // Per-full-run cost is NOT computed from a partial sum — it's null when any run is uncosted, never a
  // misleadingly precise underestimate.
  assert.equal(b.suite.costPerFullRunUsd, null);
});

test('buildBaseline computes per-full-run cost only when every run is costed', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.5, max: 0.5, n: 2 })]; // default perRun both costed (0.1, 0.3)
  const b = buildBaseline({ cases, provenance: { sha: 'abc', date: '2026-08-01' } });
  assert.equal(b.suite.uncostedRuns, 0);
  assert.equal(b.suite.totalCostUsd, 0.4);
  assert.equal(b.suite.costPerFullRunUsd, 0.2); // 0.4 / 2 repeats
});

test('buildBaseline refuses an inconsistent or empty suite loudly', () => {
  assert.throws(() => buildBaseline({ cases: [], provenance: { sha: 'a', date: 'd' } }), /no scored cases/);
  // Mixed N.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 3 }, { runs: 3 })],
    provenance: { sha: 'a', date: 'd' },
  }), /one common N/);
  // Mixed matcher.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 2 }, { matcher: 'lexical' })],
    provenance: { sha: 'a', date: 'd' },
  }), /one matcher/);
  // Mixed engine.
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: 1, min: 1, max: 1, n: 2 }), caseEntry('b', { mean: 1, min: 1, max: 1, n: 2 }, { engine: { provider: 'zai', model: 'glm', reasoning: null } })],
    provenance: { sha: 'a', date: 'd' },
  }), /one engine/);
  // Zero must-find opportunities (every perRun is 0/0) — not a gradeable baseline. Refusing at the producer
  // keeps its output loadable by parseBaseline (which requires opportunities>=1 + a finite gate floor).
  assert.throws(() => buildBaseline({
    cases: [caseEntry('a', { mean: null, min: null, max: null, n: 0 }, {
      perRun: [{ mustFind: { found: 0, total: 0 }, costUsd: 0.1 }, { mustFind: { found: 0, total: 0 }, costUsd: 0.1 }],
    })],
    provenance: { sha: 'a', date: 'd' },
  }), /zero must-find opportunities/);
});

// ── parseBaseline (the loader 2fk.5 reuses) round-trips buildBaseline ────────────────────────────────

test('parseBaseline round-trips a frozen baseline and rejects a foreign one', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 })];
  const frozen = buildBaseline({ cases, provenance: { sha: 'deadbeef', date: '2026-08-01' } });
  const loaded = parseBaseline(JSON.stringify(frozen), 'baseline.json');
  assert.equal(loaded.mainSha, 'deadbeef');
  assert.equal(loaded.repeats, 2);
  assert.equal(loaded.cases[0].case, 'case-a');
  assert.equal(loaded.cases[0].diagnosticFloor, 0.3333);
  assert.deepEqual(loaded.cases[0].mustFindRecall, { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 });
  // The pooled gate — the number 2fk.5 compares against — is loaded and typed.
  assert.equal(loaded.pooledMustFind.found, 3);
  assert.equal(loaded.pooledMustFind.opportunities, 6);
  assert.ok(typeof loaded.pooledMustFind.gateFloor === 'number');
  // A non-v1 schema, a missing sha, a missing pooled gate, or an empty case set is refused.
  assert.throws(() => parseBaseline('{}', 'x'), /not a v1 baseline/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, mainSha: '' }), 'x'), /no 'mainSha'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, cases: [] }), 'x'), /no 'cases'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, suite: { ...frozen.suite, pooledMustFind: undefined } }), 'x'), /no 'suite.pooledMustFind'/);
  assert.throws(() => parseBaseline(JSON.stringify({ ...frozen, cases: [{ case: 'a', diagnosticFloor: 'bad', mustFindRecall: { mean: 1, min: 1, max: 1, n: 1 } }] }), 'x'), /diagnosticFloor must be a finite number or null/);
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────────────

test('renderBaselineMarkdown surfaces the headline, per-case band, floor, and rule', () => {
  const cases = [caseEntry('case-a', { mean: 0.5, min: 0.3333, max: 0.6667, n: 2 })];
  const md = renderBaselineMarkdown(buildBaseline({ cases, provenance: { sha: 'deadbeefcafe1234', date: '2026-08-01' } }));
  assert.match(md, /# Eval baseline — deadbee \(2026-08-01\)/);
  assert.match(md, /deepseek-v4-pro/);
  assert.match(md, /Repeats \(N\):\*\* 2/);
  assert.match(md, /PRIMARY GATE — pooled must-find recall/);
  assert.match(md, /`case-a`/);
  assert.match(md, /## Degradation rule/);
  assert.match(md, /candidate\.suite\.pooledMustFind\.rate </);
});
