'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { filterFiles, NO_EXCLUSIONS } = require('../src/diff');
const { buildPrMaterial } = require('../src/multiscope');

// EXCLUDE_PATTERNS removes changed files from the reviewed diff, and the reviewer used to be told
// nothing about it — so a file it EXPECTED to change was absent, and absence-by-configuration was
// indistinguishable from absence-by-omission. Observed on PR #117: a confident, release-blocking
// "the build output was never regenerated" finding against a PR that regenerated it in every commit.
// The contract asserted here is the fix: what the filter removed reaches BOTH prompts of the pass,
// as a value carried from the filter — never re-globbed downstream. (zai-review-prompt-2tx)

const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};
const REPO_ROOT = '/home/runner/work/acme/acme';

const FILES = [
  { filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' },
  { filename: 'build/out.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+bundled' },
  { filename: 'deps.lock', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+pinned' },
];

describe('filterFiles — the cut and the record of the cut are one value', () => {
  test('records the paths it removed, paired with the patterns that removed them', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['build/**', '*.lock']);
    assert.deepEqual(reviewed.map(f => f.filename), ['src/a.js']);
    assert.deepEqual(excluded, { patterns: ['build/**', '*.lock'], paths: ['build/out.js', 'deps.lock'] });
  });

  test('no patterns: every file is reviewed and nothing is recorded as hidden', () => {
    const { reviewed, excluded } = filterFiles(FILES, []);
    assert.deepEqual(reviewed, FILES);
    assert.deepEqual(excluded.paths, []);
  });

  // The patterns are carried whether or not they bit; `paths` alone answers "was anything hidden?".
  test('a pattern that matched nothing hid nothing', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['vendor/**']);
    assert.deepEqual(reviewed, FILES);
    assert.deepEqual(excluded, { patterns: ['vendor/**'], paths: [] });
  });
});

describe('the reviewer is told what was removed from its view', () => {
  const { reviewed, excluded } = filterFiles(FILES, ['build/**', '*.lock']);
  const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });

  test('the worker prompt names the patterns, the count, and that absence proves nothing', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js']);
    assert.match(prompt, /EXCLUDE_PATTERNS \(build\/\*\*, \*\.lock\) removed 2 changed file\(s\) from your view/);
    assert.match(prompt, /absent by configuration, not by evidence/);
    assert.match(prompt, /never record a finding asserting one of them was missed, not updated/);
  });

  // The note must not become a route BACK to the excluded files: they are out of bounds, not merely
  // undisplayed — the opposite of the unshowable-files note, which sends the worker to read them.
  test('the worker prompt does not name the excluded paths or send the reviewer to read them', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js']);
    assert.ok(!prompt.includes('build/out.js'), 'excluded path leaked into the worker prompt');
    assert.ok(!prompt.includes('deps.lock'), 'excluded path leaked into the worker prompt');
    assert.match(prompt, /Do not read those paths/);
  });

  // A convergence sweep is a fresh hunt over the same material, so it needs the same confession —
  // otherwise the false finding simply reappears one pass later.
  test('a convergence sweep prompt carries it too', () => {
    const priorFindings = [{ path: 'src/a.js', line: 1, body: 'something', severity: 3 }];
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js'], priorFindings);
    assert.match(prompt, /THIS IS A CONVERGENCE SWEEP/);
    assert.match(prompt, /EXCLUDE_PATTERNS \(build\/\*\*, \*\.lock\) removed 2 changed file\(s\)/);
  });

  test('the scout is told too, and forbidden to scope an invisible path', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /EXCLUDE_PATTERNS \(build\/\*\*, \*\.lock\) removed 2 changed file\(s\) from the list above/);
    assert.match(prompt, /Never create a scope for, or aim a scope's focus at, a path matching those patterns/);
    assert.ok(!prompt.includes('build/out.js'), 'excluded path leaked into the scout prompt');
  });
});

describe('a run that hid nothing says nothing', () => {
  const unfiltered = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });

  test('neither prompt mentions exclusion when no patterns are configured', () => {
    assert.ok(!unfiltered.buildWorkerPrompt('all', TOOL_NAMES).includes('EXCLUDE_PATTERNS'));
    assert.ok(!unfiltered.buildScoutPrompt(TOOL_NAMES).includes('EXCLUDE_PATTERNS'));
  });

  test('NO_EXCLUSIONS is the same material as omitting the value', () => {
    const explicit = buildPrMaterial({ files: FILES, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded: NO_EXCLUSIONS });
    assert.equal(explicit.buildWorkerPrompt('all', TOOL_NAMES), unfiltered.buildWorkerPrompt('all', TOOL_NAMES));
    assert.equal(explicit.buildScoutPrompt(TOOL_NAMES), unfiltered.buildScoutPrompt(TOOL_NAMES));
  });

  // Configured-but-unmatched is the case a length-subtracting or pattern-re-globbing implementation
  // gets wrong: it would announce a filtering that never happened. Byte-identical, or it is lying.
  test('patterns that matched nothing leave both prompts byte-identical to an unconfigured run', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['vendor/**']);
    const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });
    assert.equal(material.buildWorkerPrompt('all', TOOL_NAMES), unfiltered.buildWorkerPrompt('all', TOOL_NAMES));
    assert.equal(material.buildScoutPrompt(TOOL_NAMES), unfiltered.buildScoutPrompt(TOOL_NAMES));
  });
});
