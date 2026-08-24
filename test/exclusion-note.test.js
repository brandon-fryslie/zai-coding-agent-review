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

  // Naming the PATHS, not only the patterns, is the contract: a predicate about a file the model was
  // never shown asks it to infer from an absence, and that measurably lost — delivered verbatim to all
  // 15 spawns of a real run, the patterns-only note still drew the finding it forbade.
  test('the worker prompt names the withheld paths as changed, plus the patterns and the count', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js']);
    assert.match(prompt, /Withheld from this diff — changed in this pull request:\*\* build\/out\.js, deps\.lock/);
    assert.match(prompt, /These 2 file\(s\) are part of this change and were modified by it/);
    assert.match(prompt, /EXCLUDE_PATTERNS \(build\/\*\*, \*\.lock\) removed them from your view/);
  });

  // The escape route the model actually took: it had read the repo's own rule demanding these files
  // change, and a note that only forbade the conclusion lost to it. The claim is not that the files are
  // fine — it is that compliance is unobservable from this material, in either direction.
  test('the worker prompt forecloses a repo rule about the withheld files, and is not a route back to reading them', () => {
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js']);
    assert.match(prompt, /holds equally for a repository rule you have read requiring that they change/);
    assert.match(prompt, /cannot check compliance in either direction/);
    assert.match(prompt, /Do not read these paths, and record no finding that rests on one of them/);
  });

  // Bounded: this list is paid on every engine spawn, so a PR excluding a large vendored tree must not
  // inflate it — and a truncated list that lied about its own length would be the same withheld-
  // information defect one level down.
  test('a large withheld set is capped, and says how many it did not name', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ filename: `build/f${i}.js`, status: 'modified', patch: '@@ -1,1 +1,1 @@\n+x' }));
    const { reviewed, excluded } = filterFiles([...FILES, ...many], ['build/**']);
    const prompt = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded })
      .buildWorkerPrompt('code', TOOL_NAMES, ['src/a.js']);
    assert.match(prompt, /\(and 6 more\)/);          // 1 build/out.js + 25 = 26 withheld, 20 named
    assert.match(prompt, /These 26 file\(s\) are part of this change/);
    assert.ok(!prompt.includes('build/f24.js'), 'the cap did not bound the list');
  });

  // A convergence sweep is a fresh hunt over the same material, so it needs the same confession —
  // otherwise the false finding simply reappears one pass later.
  test('a convergence sweep prompt carries it too', () => {
    const priorFindings = [{ path: 'src/a.js', line: 1, body: 'something', severity: 3 }];
    const prompt = material.buildWorkerPrompt('code — src/a.js', TOOL_NAMES, ['src/a.js'], priorFindings);
    assert.match(prompt, /THIS IS A CONVERGENCE SWEEP/);
    assert.match(prompt, /Withheld from this diff — changed in this pull request:\*\* build\/out\.js, deps\.lock/);
  });

  test('the scout is told too, and forbidden to scope a withheld path', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /Withheld from the list above — changed in this pull request:\*\* build\/out\.js, deps\.lock/);
    assert.match(prompt, /removed these 2 changed file\(s\) from the list, so their absence is a display setting, not a gap/);
    assert.match(prompt, /Create no scope for them/);
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
