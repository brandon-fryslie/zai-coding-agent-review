'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs, parseExpected, parseProduced, parseUsage, parseMeta,
  normalizeBody, pairCandidates, computeMetrics, scoreRun, aggregateRuns, renderTable,
  makeLexicalJudge, jaccard, wordSet,
  judgeCacheKey, buildJudgePrompt, parseJudgeResponse, extractText, makeLlmJudge, loadCache,
  requireLlmJudgeCredential,
} = require('../eval/score');

// [LAW:verifiable-goals] AC: the scorer reduces a run's findings.json + a case's expected.json to
// must-find recall (primary), nice-to-find recall, and noise — deterministically, via an injected
// judge. These tests inject a DETERMINISTIC fake judge so the whole scoring core is exercised with no
// network and no LLM. [LAW:behavior-not-structure] They assert the metric contract, not the internals.

// ── arg parsing ────────────────────────────────────────────────────────────────────────────────────

test('parseArgs takes the positional and applies defaults', () => {
  const o = parseArgs(['eval/out/foo']);
  assert.equal(o.caseOutDir, 'eval/out/foo');
  assert.equal(o.matcher, 'llm');
  assert.equal(o.casesDir, 'eval/cases');
  assert.equal(o.cache, 'eval/out/.judge-cache.json');
});

test('parseArgs supports flags, =value form, and --help', () => {
  const o = parseArgs(['eval/out/foo', '--matcher', 'lexical', '--cases-dir=some/cases', '--cache', 'c.json']);
  assert.equal(o.matcher, 'lexical');
  assert.equal(o.casesDir, 'some/cases');
  assert.equal(o.cache, 'c.json');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs([]), /Missing required <case-out-dir>/);
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected second positional/);
  assert.throws(() => parseArgs(['foo', '--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['foo', '--matcher']), /requires a value/);
  assert.throws(() => parseArgs(['foo', '--matcher', 'banana']), /must be 'llm' or 'lexical'/);
  // A --prefixed value is a swallowed flag, not an argument.
  assert.throws(() => parseArgs(['foo', '--cache', '--matcher=lexical']), /requires a value/);
});

// ── input parsers ──────────────────────────────────────────────────────────────────────────────────

const EXPECTED = JSON.stringify({
  reviewId: 1, headSha: 'abc',
  findings: [
    { commentId: 1, path: 'a.ts', line: 10, side: 'RIGHT', annotation: 'must-find', body: 'null deref on close' },
    { commentId: 2, path: 'a.ts', line: 50, side: 'RIGHT', annotation: 'nice-to-find', body: 'perf: reads whole file' },
    { commentId: 3, path: 'b.ts', line: 5, side: 'RIGHT', annotation: 'noise', body: 'self-neutralizing nit' },
  ],
});

test('parseExpected keeps the scoring fields and rejects bad ones', () => {
  const e = parseExpected(EXPECTED, 'expected.json');
  assert.equal(e.reviewId, 1);
  assert.equal(e.findings.length, 3);
  // A finding with no reviewId of its own belongs to the frozen round — resolved at the boundary.
  assert.deepEqual(e.findings[0], { commentId: 1, path: 'a.ts', line: 10, annotation: 'must-find', body: 'null deref on close', reviewId: 1 });
  assert.throws(() => parseExpected(JSON.stringify({ reviewId: 1 }), 'x'), /no 'findings' array/);
  assert.throws(() => parseExpected(JSON.stringify({ findings: [] }), 'x'), /no integer top-level 'reviewId'/);
  const one = (f) => JSON.stringify({ reviewId: 1, findings: [f] });
  assert.throws(() => parseExpected(one({ path: 'a', line: 1, body: 'b', annotation: 'UNREVIEWED' }), 'x'), /still UNREVIEWED/);
  assert.throws(() => parseExpected(one({ path: 'a', line: 1, body: 'b', annotation: 'maybe' }), 'x'), /invalid annotation/);
  assert.throws(() => parseExpected(one({ path: 'a', line: 0, body: 'b', annotation: 'noise' }), 'x'), /invalid line/);
  assert.throws(() => parseExpected(one({ path: '', line: 1, body: 'b', annotation: 'noise' }), 'x'), /invalid path/);
  assert.throws(() => parseExpected(one({ path: 'a', line: 1, body: 'b', annotation: 'noise', reviewId: 'r2' }), 'x'), /non-integer reviewId/);
  // Valid-but-wrong-typed JSON is rejected at the shared object boundary, not with a cryptic field-access crash.
  assert.throws(() => parseExpected('123', 'x'), /not a JSON object/);
  assert.throws(() => parseExpected('null', 'x'), /not a JSON object/);
});

test('parseExpected carries an inventory finding\'s own source round', () => {
  const e = parseExpected(JSON.stringify({
    reviewId: 10, headSha: 'abc',
    findings: [
      { commentId: 1, path: 'a.ts', line: 5, annotation: 'must-find', body: 'frozen-round defect' },
      { commentId: 2, path: 'b.ts', line: 9, annotation: 'must-find', body: 'later-round defect', reviewId: 30 },
    ],
  }), 'expected.json');
  assert.equal(e.findings[0].reviewId, 10);
  assert.equal(e.findings[1].reviewId, 30);
});

test('parseProduced accepts the raw merged-findings shape and rejects malformed', () => {
  const p = parseProduced(JSON.stringify([{ path: 'a.ts', line: 11, body: 'the close rejects', severity: 'advisory' }]), 'findings.json');
  assert.deepEqual(p[0], { path: 'a.ts', line: 11, body: 'the close rejects', severity: 'advisory' });
  assert.throws(() => parseProduced('{}', 'x'), /must be a JSON array/);
  assert.throws(() => parseProduced(JSON.stringify([{ path: 'a', line: 1 }]), 'x'), /invalid body/);
});

test('parseUsage passes cost through and tolerates missing fields', () => {
  const tokens = { inputCacheMiss: 80, inputCacheHit: 20, output: 20 };
  const span = { from: '2026-08-22T03:30:00.000Z', to: '2026-08-22T04:01:00.000Z' };
  assert.deepEqual(parseUsage(JSON.stringify({ tokens, span, cost: { basis: 'dollars', usd: 0.01 } }), 'u'),
    { tokens, span, cost: { basis: 'dollars', usd: 0.01 } });
  assert.deepEqual(parseUsage('{}', 'u'), { tokens: null, span: null, cost: null });
  // A run captured before the token split carries a COLLAPSED inputTokens/outputTokens pair, which
  // cannot be repriced — it records as absent tokens, never as zero ones. [LAW:no-silent-failure]
  assert.deepEqual(parseUsage(JSON.stringify({ inputTokens: 100, outputTokens: 20, cost: { basis: 'dollars', usd: 0.01 } }), 'u'),
    { tokens: null, span: null, cost: { basis: 'dollars', usd: 0.01 } });
  // A wrong-typed usage.json is rejected loudly, never silently treated as {} (all-null).
  assert.throws(() => parseUsage('123', 'u'), /not a JSON object/);
  assert.throws(() => parseUsage('null', 'u'), /not a JSON object/);
});

test('parseMeta reads the case name and rejects a path-shaped one', () => {
  assert.equal(parseMeta(JSON.stringify({ case: 'demo', config: { model: 'm' } }), 'm').case, 'demo');
  assert.throws(() => parseMeta('{}', 'm'), /no 'case' name/);
  assert.throws(() => parseMeta(JSON.stringify({ case: '../evil' }), 'm'), /plain directory component/);
  // `null` is valid JSON but not an object — rejected at the boundary, not a `null.case` crash.
  assert.throws(() => parseMeta('null', 'm'), /not a JSON object/);
});

// ── candidate pairing (stage 1) ────────────────────────────────────────────────────────────────────

const EXPECTED_V = parseExpected(EXPECTED, 'e');

test('pairCandidates pairs only same-path findings within the line window', () => {
  const produced = [
    { path: 'a.ts', line: 11, body: 'x', severity: null }, // within 10 of expected line 10
    { path: 'a.ts', line: 25, body: 'x', severity: null }, // 15 from line 10, 25 from line 50 → no pair
    { path: 'a.ts', line: 50, body: 'x', severity: null }, // exact match to line 50
    { path: 'c.ts', line: 10, body: 'x', severity: null }, // different file → no pair
  ];
  const pairs = pairCandidates(EXPECTED_V.findings, produced, 10);
  // expected[0] (a.ts:10) pairs with produced[0]; expected[1] (a.ts:50) pairs with produced[2].
  assert.deepEqual(pairs.map(p => p.key).sort(), ['0:0', '1:2']);
  const p00 = pairs.find(p => p.key === '0:0');
  assert.equal(p00.lineDelta, 1);
});

test('pairCandidates window edge: delta 10 pairs, delta 11 does not', () => {
  const e = [{ path: 'a', line: 100, annotation: 'must-find', body: 'x', commentId: 1 }];
  assert.equal(pairCandidates(e, [{ path: 'a', line: 110, body: 'x' }], 10).length, 1);
  assert.equal(pairCandidates(e, [{ path: 'a', line: 111, body: 'x' }], 10).length, 0);
});

// ── the deterministic fake judge: match iff bodies share a keyword ───────────────────────────────────

// A tiny deterministic judge for the scoring tests: it matches a pair when the produced body contains the
// expected body's first word. No network, fully reproducible. [LAW:behavior-not-structure]
function keywordJudge(pairs) {
  const out = new Map();
  for (const p of pairs) {
    const kw = p.expectedBody.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')[0];
    out.set(p.key, { match: p.producedBody.toLowerCase().includes(kw), reason: `kw:${kw}` });
  }
  return Promise.resolve(out);
}

test('computeMetrics buckets by annotation and counts noise', async () => {
  const produced = [
    { path: 'a.ts', line: 10, body: 'null pointer at close()', severity: 'blocking' }, // matches must-find (kw "null")
    { path: 'a.ts', line: 50, body: 'perf concern reading file', severity: 'advisory' }, // matches nice-to-find (kw "perf")
    { path: 'z.ts', line: 99, body: 'totally novel finding', severity: 'advisory' }, // matches nothing → noise
  ];
  const pairs = pairCandidates(EXPECTED_V.findings, produced, 10);
  const decisions = await keywordJudge(pairs.map(p => ({ key: p.key, expectedBody: EXPECTED_V.findings[p.expectedIdx].body, producedBody: produced[p.producedIdx].body })));
  const m = computeMetrics(EXPECTED_V, produced, pairs, decisions);
  assert.deepEqual(m.mustFind, { total: 1, found: 1, recall: 1, foundIds: [1], missedIds: [] });
  assert.deepEqual(m.niceToFind, { total: 1, found: 1, recall: 1, foundIds: [2], missedIds: [] });
  assert.equal(m.knownNoise.total, 1); // the 'noise'-annotated expected was never produced
  assert.equal(m.knownNoise.found, 0);
  // With no inventory rounds, the inventory view equals the frozen-round view.
  assert.deepEqual(m.inventoryMustFind, m.mustFind);
  assert.deepEqual(m.inventoryNiceToFind, m.niceToFind);
  assert.deepEqual(m.inventoryKnownNoise, m.knownNoise);
  assert.equal(m.noise.count, 1); // the novel z.ts finding matched nothing
  assert.equal(m.noise.items[0].path, 'z.ts');
});

test('computeMetrics: a missed must-find drops recall and is listed', async () => {
  const produced = [{ path: 'a.ts', line: 50, body: 'perf concern reading file', severity: 'advisory' }]; // only the nice-to-find
  const pairs = pairCandidates(EXPECTED_V.findings, produced, 10);
  const decisions = await keywordJudge(pairs.map(p => ({ key: p.key, expectedBody: EXPECTED_V.findings[p.expectedIdx].body, producedBody: produced[p.producedIdx].body })));
  const m = computeMetrics(EXPECTED_V, produced, pairs, decisions);
  assert.equal(m.mustFind.recall, 0);
  assert.deepEqual(m.mustFind.missedIds, [1]);
  assert.equal(m.noise.count, 0); // the produced finding matched the nice-to-find, so it is not noise
});

// The inventory view: a case whose expected set pools findings from several review rounds. The frozen-round
// buckets stay scoped to the frozen review (their numbers can't move when an inventory is added), while
// inventoryMustFind spans every round — and a produced finding that matches only a later-round defect is an
// early find, never noise. [LAW:verifiable-goals] This is the ticket's core metric.
test('computeMetrics scores inventory recall across rounds without moving frozen-round buckets', async () => {
  const expected = parseExpected(JSON.stringify({
    reviewId: 100, headSha: 'abc',
    findings: [
      { commentId: 1, path: 'a.ts', line: 10, annotation: 'must-find', body: 'null deref on close' },
      { commentId: 2, path: 'b.ts', line: 40, annotation: 'must-find', body: 'race on refold counter', reviewId: 300 },
      { commentId: 3, path: 'c.ts', line: 7, annotation: 'must-find', body: 'leak of watcher handle', reviewId: 500 },
    ],
  }), 'e');
  const produced = [
    { path: 'a.ts', line: 10, body: 'null pointer at close()', severity: 'blocking' },   // frozen-round must-find
    { path: 'b.ts', line: 42, body: 'race condition double-counts refold', severity: 'blocking' }, // round-300 must-find
  ];
  const pairs = pairCandidates(expected.findings, produced, 10);
  const decisions = await keywordJudge(pairs.map(p => ({ key: p.key, expectedBody: expected.findings[p.expectedIdx].body, producedBody: produced[p.producedIdx].body })));
  const m = computeMetrics(expected, produced, pairs, decisions);
  // Frozen-round view: only commentId 1 is in scope, and it was found.
  assert.deepEqual(m.mustFind, { total: 1, found: 1, recall: 1, foundIds: [1], missedIds: [] });
  // Inventory view: all three rounds' must-finds; 2 of 3 found, the round-500 leak missed.
  assert.deepEqual(m.inventoryMustFind, { total: 3, found: 2, recall: 2 / 3, foundIds: [1, 2], missedIds: [3] });
  // The early find of the round-300 defect is a find, not noise.
  assert.equal(m.noise.count, 0);
  // The pair detail names the source round of each expected finding.
  assert.ok(m.pairs.every(p => [100, 300].includes(p.expectedReviewId)));
});

test('computeMetrics aborts loudly if a candidate pair has no decision', () => {
  const produced = [{ path: 'a.ts', line: 10, body: 'x', severity: null }];
  const pairs = pairCandidates(EXPECTED_V.findings, produced, 10);
  assert.throws(() => computeMetrics(EXPECTED_V, produced, pairs, new Map()), /no decision for candidate pair/);
});

// ── scoreRun + aggregate ─────────────────────────────────────────────────────────────────────────────

test('scoreRun produces a timestamp-free, re-runnable scorecard', async () => {
  const produced = parseProduced(JSON.stringify([
    { path: 'a.ts', line: 10, body: 'null pointer at close()', severity: 'blocking' },
    { path: 'q.ts', line: 1, body: 'novel unrelated thing', severity: 'advisory' },
  ]), 'f');
  const args = { expected: EXPECTED_V, produced, usage: { tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 2 }, span: null, cost: { basis: 'dollars', usd: 0.5 } }, meta: { case: 'demo', config: { model: 'm' } }, judge: keywordJudge, matcherLabel: 'fake' };
  const a = await scoreRun(args);
  const b = await scoreRun(args);
  assert.deepEqual(a, b); // deterministic given the same judge
  assert.equal(a.case, 'demo');
  assert.equal(a.mustFind.recall, 1);
  // The scorecard reports the inventory view alongside the frozen-round buckets.
  assert.equal(a.inventoryMustFind.recall, 1);
  assert.equal(a.noise.count, 1);
  assert.equal(a.usage.cost.usd, 0.5);
});

test('aggregateRuns forms a mean/min/max band and skips null recalls', () => {
  // Each fixture run found `found` of the 7 frozen-round must-finds and invFound of the 9 inventory-wide ones.
  const mk = (found, total, invFound, invTotal, noise, usd) => ({
    matcher: 'fake',
    mustFind: { found, total, recall: total ? found / total : null },
    inventoryMustFind: { found: invFound, total: invTotal, recall: invTotal ? invFound / invTotal : null },
    niceToFind: { found: 0, total: 0, recall: null },
    inventoryNiceToFind: { found: 1, total: 2, recall: 0.5 },
    noise: { count: noise },
    usage: { cost: { basis: 'dollars', usd } },
  });
  const s = aggregateRuns('demo', [mk(7, 7, 8, 9, 2, 0.01), mk(5, 7, 5, 9, 4, 0.02), mk(6, 7, 6, 9, 3, 0.03)]);
  assert.equal(s.runs, 3);
  assert.equal(s.mustFindRecall.max, 1);
  assert.equal(s.mustFindRecall.min, 5 / 7);
  assert.ok(Math.abs(s.mustFindRecall.mean - (1 + 5 / 7 + 6 / 7) / 3) < 1e-9);
  // The inventory band aggregates the inventory-wide recalls, and perRun carries both fractions.
  assert.equal(s.inventoryMustFindRecall.max, 8 / 9);
  assert.equal(s.inventoryMustFindRecall.min, 5 / 9);
  assert.deepEqual(s.perRun.map(r => r.inventoryMustFind), ['8/9', '5/9', '6/9']);
  assert.equal(s.niceToFindRecall.n, 0); // all null → skipped, band is empty
  assert.equal(s.niceToFindRecall.mean, null);
  // The inventory nice-to-find band is aggregated too (not dead per-run storage), with a perRun fraction.
  assert.equal(s.inventoryNiceToFindRecall.mean, 0.5);
  assert.deepEqual(s.perRun.map(r => r.inventoryNiceToFind), ['1/2', '1/2', '1/2']);
  assert.equal(s.noiseCount.mean, 3);
  assert.ok(Math.abs(s.costUsd.mean - 0.02) < 1e-9);
  assert.ok(renderTable(s).includes('must-find recall'));
  assert.ok(renderTable(s).includes('inventory recall'));
});

// The eval scorer is a spend fold like any other, so it obeys the same rule: only a DOLLARS-basis run
// contributes to the cost band. A subscription run's notional list price is Anthropic's sticker for
// tokens nobody was charged for — folding it in would make one baseline compare list price against
// money, the exact miscount ($63.59 of notional read as spend) this change exists to kill. A notional
// run drops out of the band entirely rather than landing in it as a zero, which would drag the mean.
test('aggregateRuns costs only dollars-basis runs — notional and unpriced drop out of the band', () => {
  const mk = cost => ({
    matcher: 'fake',
    mustFind: { found: 1, total: 1, recall: 1 },
    inventoryMustFind: { found: 1, total: 1, recall: 1 },
    niceToFind: { found: 0, total: 0, recall: null },
    inventoryNiceToFind: { found: 0, total: 0, recall: null },
    noise: { count: 0 },
    usage: cost === null ? null : { cost },
  });
  const s = aggregateRuns('demo', [
    mk({ basis: 'dollars', usd: 0.10 }),
    mk({ basis: 'subscription', notionalUsd: 63.59 }),
    mk({ basis: 'unpriced', reason: 'no-price' }),
    mk(null),
    mk({ basis: 'dollars', usd: 0.30 }),
  ]);
  assert.equal(s.runs, 5);
  assert.equal(s.costUsd.n, 2, 'only the two dollars runs are costed');
  assert.ok(Math.abs(s.costUsd.mean - 0.20) < 1e-9, 'the notional 63.59 never reaches the mean');
  assert.equal(s.costUsd.max, 0.30);
});

// ── lexical judge (the offline fallback) ─────────────────────────────────────────────────────────────

test('jaccard and the lexical judge match paraphrases, reject unrelated', async () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  const judge = makeLexicalJudge();
  const out = await judge([
    { key: 'p', expectedBody: 'the close call rejects and escapes the typed outcome', producedBody: 'the close call rejects, escaping the typed outcome entirely' },
    { key: 'q', expectedBody: 'the close call rejects and escapes the typed outcome', producedBody: 'unrelated day-cost divergence in the bucket' },
  ]);
  assert.equal(out.get('p').match, true);
  assert.equal(out.get('q').match, false);
});

// ── llm judge boundary bits (no real network) ────────────────────────────────────────────────────────

test('judgeCacheKey is content-stable and version/model-scoped', () => {
  const a = judgeCacheKey('m', 'Expected  BODY', 'produced body');
  const b = judgeCacheKey('m', 'expected body', 'produced   body'); // whitespace/case-normalized → same
  assert.equal(a, b);
  assert.notEqual(a, judgeCacheKey('other-model', 'expected body', 'produced body'));
});

test('extractText returns the LAST text block (past a leading thinking block)', () => {
  const env = { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '[{"i":1,"match":true}]' }] };
  assert.equal(extractText(env), '[{"i":1,"match":true}]');
  assert.throws(() => extractText({ content: [{ type: 'thinking', thinking: 'x' }] }), /no text block/);
});

test('parseJudgeResponse reads the array, tolerates surrounding prose, and aborts on gaps', () => {
  const ds = parseJudgeResponse('here you go: [{"i":1,"match":true,"reason":"same"},{"i":2,"match":false,"reason":"diff"}]', 2);
  assert.deepEqual(ds, [{ match: true, reason: 'same' }, { match: false, reason: 'diff' }]);
  assert.throws(() => parseJudgeResponse('no array here', 1), /not a JSON array or object/);
  assert.throws(() => parseJudgeResponse('[{"i":1,"match":true}]', 2), /omitted a decision for pair 2/);
  assert.throws(() => parseJudgeResponse('[{"i":1,"match":"yes"}]', 1), /malformed/);
});

// The judge drops the [] and emits a BARE OBJECT for a single-pair batch — a valid instance of the
// one-object-per-pair contract that must read identically to a one-element array. [LAW:one-type-per-behavior]
test('parseJudgeResponse accepts a bare single object for a one-pair batch', () => {
  assert.deepEqual(parseJudgeResponse('{"i":1,"match":false,"reason":"different defects"}', 1), [{ match: false, reason: 'different defects' }]);
  // Prose around the bare object is still tolerated (outermost braces).
  assert.deepEqual(parseJudgeResponse('sure: {"i":1,"match":true,"reason":"same"}', 1), [{ match: true, reason: 'same' }]);
  // A bare object that omits the pair it claims still aborts loudly.
  assert.throws(() => parseJudgeResponse('{"i":2,"match":true}', 1), /omitted a decision for pair 1/);
});

// The judge sometimes emits a STREAM of bare objects separated by blank lines for a multi-pair batch —
// observed live (deepseek-v4-flash, cc-candybar scoring, 2026-08-10) and deterministic for some batches,
// so it must read as the same one-object-per-pair contract, not abort the case's whole scorecard.
test('parseJudgeResponse accepts concatenated bare objects for a multi-pair batch', () => {
  const stream = '{"i": 1, "match": true, "reason": "same defect"}\n\n{"i": 2, "match": false, "reason": "different"}\n\n{"i": 3, "match": true, "reason": "brace {inside} a string"}';
  assert.deepEqual(parseJudgeResponse(stream, 3), [
    { match: true, reason: 'same defect' },
    { match: false, reason: 'different' },
    { match: true, reason: 'brace {inside} a string' },
  ]);
  // The array form stays preferred: an array response whose reasons contain braces is read as the array.
  const arr = parseJudgeResponse('[{"i":1,"match":true,"reason":"a {b}"},{"i":2,"match":true,"reason":"c"}]', 2);
  assert.equal(arr.length, 2);
  // A stream that omits a pair still aborts loudly — completeness stays enforced downstream.
  assert.throws(() => parseJudgeResponse('{"i":1,"match":true}\n\n{"i":3,"match":true}', 3), /omitted a decision for pair 2/);
  // An unparseable object in the stream aborts the extraction rather than dropping rulings.
  assert.throws(() => parseJudgeResponse('{"i":1,"match":true}\n\n{"i":2 match:false}', 2), /not valid JSON/);
});

test('buildJudgePrompt numbers pairs and states the JSON contract', () => {
  const prompt = buildJudgePrompt([{ expectedBody: 'E1', producedBody: 'P1' }, { expectedBody: 'E2', producedBody: 'P2' }]);
  assert.ok(prompt.includes('Pair 1:'));
  assert.ok(prompt.includes('Pair 2:'));
  assert.ok(prompt.includes('EXPECTED: E1'));
  assert.ok(/JSON array/.test(prompt));
});

test('makeLlmJudge caches by content and only fetches uncached pairs', async () => {
  const tmp = require('path').join(require('os').tmpdir(), `judge-cache-${process.pid}-${Date.now()}.json`);
  let fetchCalls = 0;
  const fakeFetch = async (_url, opts) => {
    fetchCalls++;
    // Echo one match:true per pair in the batch, in order.
    const body = JSON.parse(opts.body);
    const n = (body.messages[0].content.match(/Pair \d+:/g) || []).length;
    const arr = Array.from({ length: n }, (_, k) => ({ i: k + 1, match: true, reason: 'ok' }));
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(arr) }] }) };
  };
  const judge = makeLlmJudge({ apiKey: 'k', model: 'deepseek-v4-flash', cacheFile: tmp, fetchImpl: fakeFetch });
  const pairs = [{ key: '0:0', expectedBody: 'E', producedBody: 'P' }];
  const first = await judge(pairs);
  assert.equal(first.get('0:0').match, true);
  assert.equal(fetchCalls, 1);
  // Second call with the same content hits the cache — no new fetch (this is the determinism guarantee).
  const judge2 = makeLlmJudge({ apiKey: 'k', model: 'deepseek-v4-flash', cacheFile: tmp, fetchImpl: fakeFetch });
  const second = await judge2(pairs);
  assert.equal(second.get('0:0').match, true);
  assert.equal(fetchCalls, 1);
  require('fs').rmSync(tmp, { force: true });
});

test('loadCache returns {} when absent and aborts loudly on a corrupt or wrong-typed cache', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const f = path.join(os.tmpdir(), `judge-cache-load-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(loadCache(f), {}); // missing file → empty map, not an error
  fs.writeFileSync(f, '{not json');
  assert.throws(() => loadCache(f), /not valid JSON.*Delete it to rebuild/s);
  // Valid JSON of the wrong type must be rejected at the boundary — otherwise `ck in cache` crashes inland.
  for (const bad of ['123', '"a string"', '[1,2,3]', 'null']) {
    fs.writeFileSync(f, bad);
    assert.throws(() => loadCache(f), /not a JSON object.*Delete it to rebuild/s, `expected reject for ${bad}`);
  }
  fs.writeFileSync(f, '{"ck":{"match":true,"reason":"r"}}');
  assert.deepEqual(loadCache(f), { ck: { match: true, reason: 'r' } });
  fs.rmSync(f, { force: true });
});

// ── requireLlmJudgeCredential (the shared llm-matcher credential check) ──────────────────────────────

test('requireLlmJudgeCredential returns the key when set, throws naming ANTHROPIC_API_KEY when absent', () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    assert.equal(requireLlmJudgeCredential(), 'test-key-123');

    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(() => requireLlmJudgeCredential(), /ANTHROPIC_API_KEY/);
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

// The judge's credential must NOT be the engine's. A judge that read whatever the reviewed provider
// reads would move with the thing it measures — and, concretely, a case pinned to the subscription
// supplies an OAuth token that is not a usable API key for a raw Messages call. [LAW:one-source-of-truth]
test('requireLlmJudgeCredential does not fall back to any engine credential', () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    for (const k of ['DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) process.env[k] = 'engine-credential';
    assert.throws(() => requireLlmJudgeCredential(), /ANTHROPIC_API_KEY/);
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('makeLlmJudge surfaces a non-200 loudly', async () => {
  const tmp = require('path').join(require('os').tmpdir(), `judge-cache-err-${process.pid}-${Date.now()}.json`);
  const judge = makeLlmJudge({ apiKey: 'k', model: 'm', cacheFile: tmp, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Authentication Fails' }) });
  await assert.rejects(() => judge([{ key: '0:0', expectedBody: 'E', producedBody: 'P' }]), /HTTP 401/);
  require('fs').rmSync(tmp, { force: true });
});

test('makeLlmJudge names the judge when a 200 body is not JSON', async () => {
  const tmp = require('path').join(require('os').tmpdir(), `judge-cache-badjson-${process.pid}-${Date.now()}.json`);
  // A 200 whose body is an HTML proxy page: json() throws a bare parse error, re-thrown with judge context.
  const judge = makeLlmJudge({ apiKey: 'k', model: 'm', cacheFile: tmp, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token <'); } }) });
  await assert.rejects(() => judge([{ key: '0:0', expectedBody: 'E', producedBody: 'P' }]), /Judge response was HTTP 200 but not valid JSON/);
  require('fs').rmSync(tmp, { force: true });
});
