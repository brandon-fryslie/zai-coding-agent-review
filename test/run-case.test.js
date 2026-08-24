'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseArgs, parseCaseManifest, buildProviderInputs, assertConfigMatchesPin, runDirName, buildCaseMaterial } = require('../eval/run-case');

test('parseArgs takes the required positional and applies defaults', () => {
  const o = parseArgs(['eval/cases/foo']);
  assert.equal(o.caseDir, 'eval/cases/foo');
  assert.equal(o.repeats, 1);
  assert.equal(o.out, 'eval/out');
  assert.equal(o.workers, 4);
});

test('parseArgs supports -n alias, --flag=value, and --help', () => {
  const o = parseArgs(['eval/cases/foo', '-n', '3', '--workers=2', '--out', 'tmp/out']);
  assert.equal(o.repeats, 3);
  assert.equal(o.workers, 2);
  assert.equal(o.out, 'tmp/out');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs([]), /Missing required <case-dir>/);
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected second positional/);
  assert.throws(() => parseArgs(['foo', '--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['foo', '--repeats']), /requires a value/);
  assert.throws(() => parseArgs(['foo', '-n', '0']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '-n', 'x']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '--workers', '-1']), /positive integer/);
  // Non-integers are rejected, never silently truncated (parseInt('2.5') would have accepted 2).
  assert.throws(() => parseArgs(['foo', '-n', '2.5']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '--workers', '3.7']), /positive integer/);
  assert.throws(() => parseArgs(['foo', '-n', '2abc']), /positive integer/);
  // A valid positive integer still parses to a number.
  assert.equal(parseArgs(['foo', '-n', '3']).repeats, 3);
  // A `--`-prefixed value is a swallowed flag, not a path — rejected rather than silently consumed.
  assert.throws(() => parseArgs(['foo', '--out', '--workers=2']), /looks like another flag/);
  // A single-dash value (a negative number) still routes to its own validator, not the flag guard.
  assert.throws(() => parseArgs(['foo', '--workers', '-1']), /positive integer/);
});

const VALID_CASE = JSON.stringify({
  name: 'demo', diff: 'change.diff', tree: 'repo.tar.gz', expected: 'expected.json',
  engine: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null },
  excludePatterns: ['*.lock'],
});

test('parseCaseManifest resolves paths and normalizes reasoning', () => {
  const m = parseCaseManifest(VALID_CASE, '/cases/demo');
  assert.equal(m.name, 'demo');
  assert.equal(m.diffPath, path.join('/cases/demo', 'change.diff'));
  assert.equal(m.treePath, path.join('/cases/demo', 'repo.tar.gz'));
  assert.deepEqual(m.engine, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null });
  assert.deepEqual(m.excludePatterns, ['*.lock']);
});

test('parseCaseManifest defaults absent reasoning to null and excludePatterns to []', () => {
  const m = parseCaseManifest(JSON.stringify({
    name: 'x', diff: 'd', tree: 't', engine: { provider: 'deepseek', model: 'm' },
  }), '/c');
  assert.equal(m.engine.reasoning, null);
  assert.deepEqual(m.excludePatterns, []);
});

test('parseCaseManifest fails loudly on malformed input', () => {
  assert.throws(() => parseCaseManifest('{not json', '/c'), /not valid JSON/);
  assert.throws(() => parseCaseManifest('{}', '/c'), /missing a valid string 'name'/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't' }), '/c'), /missing an 'engine'/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { model: 'm' } }), '/c'), /engine\.provider/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p' } }), '/c'), /engine\.model/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' }, excludePatterns: 'no' }), '/c'), /excludePatterns.*array/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm', reasoning: 3 } }), '/c'), /reasoning.*non-empty string/);
  // An empty-string reasoning is rejected at the boundary, not surfaced as a confusing pin mismatch later.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'x', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm', reasoning: '' } }), '/c'), /reasoning.*non-empty string/);
  // A name that isn't a plain path component can't reach path.join.
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: '../evil', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: 'a/b', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
  assert.throws(() => parseCaseManifest(JSON.stringify({ name: '..', diff: 'd', tree: 't', engine: { provider: 'p', model: 'm' } }), '/c'), /plain directory component/);
});

test('buildProviderInputs reads each provider credential from its own env var and pins the model', () => {
  const env = { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'z-key', OPENAI_API_KEY: 'o-key' };
  const inputs = buildProviderInputs({ provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: null }, env);
  assert.equal(inputs.provider, 'deepseek');
  assert.equal(inputs.deepseekApiKey, 'ds-key');
  assert.equal(inputs.deepseekModel, 'deepseek-v4-pro');
  // pinned model set under every provider's model key so whichever provider synth selects reads the pin
  assert.equal(inputs.zaiModel, 'deepseek-v4-pro');
  assert.equal(inputs.openaiModel, 'deepseek-v4-pro');
  assert.equal(inputs.openaiReasoning, undefined);
});

test('buildProviderInputs threads a non-null reasoning to the reasoning key', () => {
  const inputs = buildProviderInputs({ provider: 'codex', model: 'gpt-5.4-mini', reasoning: 'high' }, { OPENAI_API_KEY: 'o' });
  assert.equal(inputs.openaiReasoning, 'high');
});

test('assertConfigMatchesPin returns the config when the pin holds', () => {
  const config = { model: 'deepseek-v4-pro', reasoning: null };
  assert.equal(assertConfigMatchesPin(config, { model: 'deepseek-v4-pro', reasoning: null }), config);
  // undefined reasoning on the config is treated as the same "no reasoning" as a null pin
  const c2 = { model: 'm' };
  assert.equal(assertConfigMatchesPin(c2, { model: 'm', reasoning: null }), c2);
});

test('assertConfigMatchesPin refuses a model or reasoning drift loudly', () => {
  assert.throws(
    () => assertConfigMatchesPin({ model: 'other-model' }, { model: 'deepseek-v4-pro', reasoning: null }),
    /Model-pin mismatch.*deepseek-v4-pro.*other-model/,
  );
  assert.throws(
    () => assertConfigMatchesPin({ model: 'm', reasoning: 'low' }, { model: 'm', reasoning: 'high' }),
    /Reasoning-pin mismatch/,
  );
});

test('runDirName composes an append-only, sortable run directory name', () => {
  assert.equal(runDirName('2026-08-01T17-43-00-123Z', 2), '2026-08-01T17-43-00-123Z-run2');
});

// ── buildCaseMaterial — the replay's filter → material path ───────────────────────────────────────
// This wiring broke silently once already: filterFiles' return shape changed and nothing under
// `npm test` executed it, so a green suite hid a guaranteed TypeError. The contract asserted here is
// what a replay must reproduce — production's filtering AND production's material, note included.

const CASE_FILES = [
  { filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' },
  { filename: 'dist/index.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+bundled' },
];
const CASE_TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};

test("buildCaseMaterial filters the case through production's seam and returns the split", () => {
  const { files, excluded, material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: ['dist/**'], reviewedRepoRoot: '/tmp/tree',
  });
  assert.deepEqual(files.map(f => f.filename), ['src/a.js']);
  assert.deepEqual(excluded, { patterns: ['dist/**'], paths: ['dist/index.js'] });
  assert.deepEqual(material.changedPaths, ['src/a.js']);
});

// The specific regression the extraction exists to catch: `excluded` silently dropping out of the
// buildPrMaterial call would leave a replay scoring the reviewer against a prompt production never sends.
test("buildCaseMaterial threads the exclusion record into the material, so a replay renders production's prompts", () => {
  const { material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: ['dist/**'], reviewedRepoRoot: '/tmp/tree',
  });
  const worker = material.buildWorkerPrompt('scope', CASE_TOOL_NAMES, ['src/a.js']);
  assert.match(worker, /EXCLUDE_PATTERNS \(dist\/\*\*\) removed 1 changed file\(s\) from your view/);
  assert.match(material.buildScoutPrompt(CASE_TOOL_NAMES), /EXCLUDE_PATTERNS \(dist\/\*\*\) removed 1 changed file\(s\)/);
});

test('buildCaseMaterial with no exclusions reviews every file and says nothing about exclusion', () => {
  const { files, excluded, material } = buildCaseMaterial({
    allFiles: CASE_FILES, excludePatterns: [], reviewedRepoRoot: '/tmp/tree',
  });
  assert.equal(files.length, 2);
  assert.deepEqual(excluded.paths, []);
  assert.ok(!material.buildWorkerPrompt('scope', CASE_TOOL_NAMES).includes('EXCLUDE_PATTERNS'));
});

test('buildCaseMaterial refuses a case whose patterns exclude everything, rather than replaying it empty', () => {
  assert.throws(
    () => buildCaseMaterial({ allFiles: CASE_FILES, excludePatterns: ['**'], reviewedRepoRoot: '/tmp/tree' }),
    /All 2 changed file\(s\) were excluded/,
  );
});
