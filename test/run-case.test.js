'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseArgs, parseCaseManifest, resolvePinnedConfig, assertConfigMatchesPin, runDirName, buildCaseMaterial } = require('../eval/run-case');

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

// THE regression this file exists to hold. The harness used to hand-build the provider input bag from a
// list of key names it kept privately, and that list omitted claude-subscription — so the instrument
// that measures review quality could not replay on the provider production runs on, and said so only as
// a confusing "credential not set". Parameterizing over the real PROVIDERS table means a provider row
// added tomorrow is covered the day it lands, rather than the day someone notices. [LAW:no-silent-failure]
describe('resolvePinnedConfig reaches every provider in the table', () => {
  const { PROVIDERS } = require('../src/provider');

  for (const [name, spec] of Object.entries(PROVIDERS)) {
    test(`'${name}': a case pinned to it resolves to a config carrying the pin`, () => {
      const engine = { provider: name, model: spec.defaultModel, reasoning: null };
      const config = resolvePinnedConfig(engine, { [spec.credentialInput]: 'test-credential' });
      assert.equal(config.model, spec.defaultModel);
      assert.equal(config.engine, spec.engine);
      assert.equal(config.endpoint.credential.value, 'test-credential');
    });

    // The credential must come from the row's OWN env var: a case pinned to one provider must never
    // resolve by picking up whatever other credential happens to be in the environment.
    test(`'${name}': refuses to resolve from another provider's credential`, () => {
      const foreign = Object.values(PROVIDERS)
        .filter(s => s.credentialInput !== spec.credentialInput)
        .reduce((env, s) => ({ ...env, [s.credentialInput]: 'wrong-credential' }), {});
      assert.throws(
        () => resolvePinnedConfig({ provider: name, model: spec.defaultModel, reasoning: null }, foreign),
        new RegExp(spec.credentialInput),
      );
    });
  }
});

test('resolvePinnedConfig pins a non-default model through the provider it names', () => {
  const config = resolvePinnedConfig(
    { provider: 'claude-subscription', model: 'claude-opus-5', reasoning: null },
    { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
  );
  assert.equal(config.model, 'claude-opus-5');
});

test('resolvePinnedConfig refuses a pin the resolved provider cannot carry', () => {
  // claude-subscription's row declares no reasoning key, so a reasoning pin has nowhere to land and is
  // silently dropped by resolution. The checkpoint is what turns that into a loud refusal — replaying
  // at a different effort than the case pins would corrupt every number measured against it.
  assert.throws(
    () => resolvePinnedConfig(
      { provider: 'claude-subscription', model: 'claude-sonnet-5', reasoning: 'high' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
    ),
    /Reasoning-pin mismatch/,
  );
});

test('resolvePinnedConfig resolves the `auto` alias to the provider production runs on', () => {
  // The drift this whole change exists to close: `auto` is what production names, and a case pinned to
  // it must reach the concrete provider the alias currently points at, credential and all.
  const { PROVIDER_ALIASES, PROVIDERS } = require('../src/provider');
  const target = PROVIDERS[PROVIDER_ALIASES.auto];
  const config = resolvePinnedConfig(
    { provider: 'auto', model: target.defaultModel, reasoning: null },
    { [target.credentialInput]: 'live-credential' },
  );
  assert.equal(config.endpoint.credential.value, 'live-credential');
  assert.equal(config.model, target.defaultModel);
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
  assert.match(worker, /Withheld from this diff — changed in this pull request:\*\* dist\/index\.js/);
  assert.match(material.buildScoutPrompt(CASE_TOOL_NAMES), /Withheld from the list above — changed in this pull request:\*\* dist\/index\.js/);
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
