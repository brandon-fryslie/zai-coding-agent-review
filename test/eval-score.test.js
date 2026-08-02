'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArgs, parseExpected, parseProduced, parseUsage, parseMeta,
  normalizeBody, pairCandidates, computeMetrics, scoreRun, aggregateRuns, renderTable,
  makeLexicalJudge, jaccard, wordSet,
  judgeCacheKey, buildJudgePrompt, parseJudgeResponse, extractText, makeLlmJudge,
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
  assert.equal(e.length, 3);
  assert.deepEqual(e[0], { commentId: 1, path: 'a.ts', line: 10, annotation: 'must-find', body: 'null deref on close' });
  assert.throws(() => parseExpected('{}', 'x'), /no 'findings' array/);
  assert.throws(() => parseExpected(JSON.stringify({ findings: [{ path: 'a', line: 1, body: 'b', annotation: 'UNREVIEWED' }] }), 'x'), /still UNREVIEWED/);
  assert.throws(() => parseExpected(JSON.stringify({ findings: [{ path: 'a', line: 1, body: 'b', annotation: 'maybe' }] }), 'x'), /invalid annotation/);
  assert.throws(() => parseExpected(JSON.stringify({ findings: [{ path: 'a', line: 0, body: 'b', annotation: 'noise' }] }), 'x'), /invalid line/);
  assert.throws(() => parseExpected(JSON.stringify({ findings: [{ path: '', line: 1, body: 'b', annotation: 'noise' }] }), 'x'), /invalid path/);
});

test('parseProduced accepts the raw merged-findings shape and rejects malformed', () => {
  const p = parseProduced(JSON.stringify([{ path: 'a.ts', line: 11, body: 'the close rejects', severity: 'advisory' }]), 'findings.json');
  assert.deepEqual(p[0], { path: 'a.ts', line: 11, body: 'the close rejects', severity: 'advisory' });
  assert.throws(() => parseProduced('{}', 'x'), /must be a JSON array/);
  assert.throws(() => parseProduced(JSON.stringify([{ path: 'a', line: 1 }]), 'x'), /invalid body/);
});

test('parseUsage passes cost through and tolerates missing fields', () => {
  assert.deepEqual(parseUsage(JSON.stringify({ inputTokens: 100, outputTokens: 20, cost: { available: true, usd: 0.01 } }), 'u'),
    { inputTokens: 100, outputTokens: 20, cost: { available: true, usd: 0.01 } });
  assert.deepEqual(parseUsage('{}', 'u'), { inputTokens: null, outputTokens: null, cost: null });
});

test('parseMeta reads the case name and rejects a path-shaped one', () => {
  assert.equal(parseMeta(JSON.stringify({ case: 'demo', config: { model: 'm' } }), 'm').case, 'demo');
  assert.throws(() => parseMeta('{}', 'm'), /no 'case' name/);
  assert.throws(() => parseMeta(JSON.stringify({ case: '../evil' }), 'm'), /plain directory component/);
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
  const pairs = pairCandidates(EXPECTED_V, produced, 10);
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
  const pairs = pairCandidates(EXPECTED_V, produced, 10);
  const decisions = await keywordJudge(pairs.map(p => ({ key: p.key, expectedBody: EXPECTED_V[p.expectedIdx].body, producedBody: produced[p.producedIdx].body })));
  const m = computeMetrics(EXPECTED_V, produced, pairs, decisions);
  assert.deepEqual(m.mustFind, { total: 1, found: 1, recall: 1, foundIds: [1], missedIds: [] });
  assert.deepEqual(m.niceToFind, { total: 1, found: 1, recall: 1, foundIds: [2], missedIds: [] });
  assert.equal(m.knownNoise.total, 1); // the 'noise'-annotated expected was never produced
  assert.equal(m.knownNoise.found, 0);
  assert.equal(m.noise.count, 1); // the novel z.ts finding matched nothing
  assert.equal(m.noise.items[0].path, 'z.ts');
});

test('computeMetrics: a missed must-find drops recall and is listed', async () => {
  const produced = [{ path: 'a.ts', line: 50, body: 'perf concern reading file', severity: 'advisory' }]; // only the nice-to-find
  const pairs = pairCandidates(EXPECTED_V, produced, 10);
  const decisions = await keywordJudge(pairs.map(p => ({ key: p.key, expectedBody: EXPECTED_V[p.expectedIdx].body, producedBody: produced[p.producedIdx].body })));
  const m = computeMetrics(EXPECTED_V, produced, pairs, decisions);
  assert.equal(m.mustFind.recall, 0);
  assert.deepEqual(m.mustFind.missedIds, [1]);
  assert.equal(m.noise.count, 0); // the produced finding matched the nice-to-find, so it is not noise
});

test('computeMetrics aborts loudly if a candidate pair has no decision', () => {
  const produced = [{ path: 'a.ts', line: 10, body: 'x', severity: null }];
  const pairs = pairCandidates(EXPECTED_V, produced, 10);
  assert.throws(() => computeMetrics(EXPECTED_V, produced, pairs, new Map()), /no decision for candidate pair/);
});

// ── scoreRun + aggregate ─────────────────────────────────────────────────────────────────────────────

test('scoreRun produces a timestamp-free, re-runnable scorecard', async () => {
  const produced = parseProduced(JSON.stringify([
    { path: 'a.ts', line: 10, body: 'null pointer at close()', severity: 'blocking' },
    { path: 'q.ts', line: 1, body: 'novel unrelated thing', severity: 'advisory' },
  ]), 'f');
  const args = { expected: EXPECTED_V, produced, usage: { inputTokens: 1, outputTokens: 2, cost: { available: true, usd: 0.5 } }, meta: { case: 'demo', config: { model: 'm' } }, judge: keywordJudge, matcherLabel: 'fake' };
  const a = await scoreRun(args);
  const b = await scoreRun(args);
  assert.deepEqual(a, b); // deterministic given the same judge
  assert.equal(a.case, 'demo');
  assert.equal(a.mustFind.recall, 1);
  assert.equal(a.noise.count, 1);
  assert.equal(a.usage.cost.usd, 0.5);
});

test('aggregateRuns forms a mean/min/max band and skips null recalls', () => {
  const mk = (found, total, noise, usd) => ({
    matcher: 'fake',
    mustFind: { found, total, recall: total ? found / total : null },
    niceToFind: { found: 0, total: 0, recall: null },
    noise: { count: noise },
    usage: { cost: { available: true, usd } },
  });
  const s = aggregateRuns('demo', [mk(7, 7, 2, 0.01), mk(5, 7, 4, 0.02), mk(6, 7, 3, 0.03)]);
  assert.equal(s.runs, 3);
  assert.equal(s.mustFindRecall.max, 1);
  assert.equal(s.mustFindRecall.min, 5 / 7);
  assert.ok(Math.abs(s.mustFindRecall.mean - (1 + 5 / 7 + 6 / 7) / 3) < 1e-9);
  assert.equal(s.niceToFindRecall.n, 0); // all null → skipped, band is empty
  assert.equal(s.niceToFindRecall.mean, null);
  assert.equal(s.noiseCount.mean, 3);
  assert.ok(Math.abs(s.costUsd.mean - 0.02) < 1e-9);
  assert.ok(renderTable(s).includes('must-find recall'));
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
  assert.throws(() => parseJudgeResponse('no array here', 1), /not a JSON array/);
  assert.throws(() => parseJudgeResponse('[{"i":1,"match":true}]', 2), /omitted a decision for pair 2/);
  assert.throws(() => parseJudgeResponse('[{"i":1,"match":"yes"}]', 1), /malformed/);
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

test('makeLlmJudge surfaces a non-200 loudly', async () => {
  const tmp = require('path').join(require('os').tmpdir(), `judge-cache-err-${process.pid}-${Date.now()}.json`);
  const judge = makeLlmJudge({ apiKey: 'k', model: 'm', cacheFile: tmp, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'Authentication Fails' }) });
  await assert.rejects(() => judge([{ key: '0:0', expectedBody: 'E', producedBody: 'P' }]), /HTTP 401/);
  require('fs').rmSync(tmp, { force: true });
});
