'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { filterFiles, NO_EXCLUSIONS, excludedPathList } = require('../src/diff');
const { buildPrMaterial, buildRepoMaterial, planScopes } = require('../src/multiscope');

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

// Telling the scout the withheld filenames is what lets it avoid scoping them — and is also the only
// reason it could ever name one, since before this change those names were not in its material at all.
// A withheld path surviving into a scope reaches buildReviewInput's scopeFiles and renders as "Read the
// complete content of THESE files", the literal opposite of the same prompt's "Do not read these paths".
// The prompt sentence is the request; the plan boundary is the guarantee. [LAW:types-are-the-program]
describe('the plan boundary strips what the prompt merely forbids', () => {
  const scoped = (name, files) => ({ name, focus: `review ${name}`, files });

  test('a withheld path the scout scoped is removed from the plan and reported', () => {
    const { scopes, withheldAssignments } = planScopes(
      [scoped('code', ['src/a.js', 'build/out.js'])],
      ['src/a.js'],
      ['build/out.js'],
    );
    assert.deepEqual(scopes[0].files, ['src/a.js']);
    assert.deepEqual(withheldAssignments, ['build/out.js']);
  });

  // An emptied scope must not survive: buildReviewInput reads an empty scopeFiles as "no assigned files"
  // and falls back to "read every changed file in full", so passing one through would silently undo
  // scope-bounded reads — a cost regression wearing the shape of a safety check.
  test('a scope left empty by the strip is dropped, not passed through with no files', () => {
    const { scopes } = planScopes(
      [scoped('code', ['src/a.js']), scoped('bundle', ['build/out.js'])],
      ['src/a.js'],
      ['build/out.js'],
    );
    assert.deepEqual(scopes.map(s => s.name), ['code']);
    assert.ok(scopes.every(s => s.files.length > 0));
  });

  // The strip runs BEFORE coverage is computed, so a reviewable path orphaned by a dropped scope is
  // caught by the existing catch-all rather than needing a second coverage mechanism.
  test('a reviewable path orphaned by a dropped scope falls into the catch-all', () => {
    const { scopes, sweptPaths } = planScopes(
      [scoped('mixed', ['src/a.js', 'build/out.js']), scoped('bundle', ['build/out.js'])],
      ['src/a.js', 'src/b.js'],
      ['build/out.js'],
    );
    // The drop is asserted, not assumed: without it 'bundle' survives and the catch-all assertions
    // below still hold, so this test would pass against a strip that never ran.
    assert.deepEqual(scopes.map(s => s.name), ['mixed', 'unassigned files']);
    assert.deepEqual(sweptPaths, ['src/b.js']);
    assert.deepEqual(scopes[scopes.length - 1].files, ['src/b.js']);
  });

  // Reported once however many scopes claimed it — and NOT as a duplicate, because after the strip no
  // worker reads it at all. A duplicate warning here would describe a review that does not exist.
  test('a withheld path claimed by two scopes is reported once, and never as a duplicate read', () => {
    const { withheldAssignments, duplicatePaths } = planScopes(
      [scoped('one', ['src/a.js', 'build/out.js']), scoped('two', ['src/b.js', 'build/out.js'])],
      ['src/a.js', 'src/b.js'],
      ['build/out.js'],
    );
    assert.deepEqual(withheldAssignments, ['build/out.js']);
    assert.deepEqual(duplicatePaths, []);
  });

  // The regression a `changedPaths`-complement check would cause. buildRepoMaterial carries
  // changedPaths: [] BY DESIGN, so "strip anything not in changedPaths" would strip every file of every
  // scope on every repo run and leave the plan empty. The predicate is the withheld set itself.
  test('repo material scopes survive untouched — changedPaths is empty by design, not a signal', () => {
    const material = buildRepoMaterial({ scope: 'security', excludePatterns: ['build/**'], reviewedRepoRoot: '/repo' });
    const plan = [scoped('auth', ['src/auth.js']), scoped('io', ['src/io.js'])];
    const { scopes, withheldAssignments } = planScopes(plan, material.changedPaths, material.withheldPaths);
    assert.equal(scopes, plan);                                    // the input itself, not a copy
    assert.deepEqual(scopes.map(s => s.files), [['src/auth.js'], ['src/io.js']]);
    assert.deepEqual(withheldAssignments, []);
  });

  test('a withheld set that matched no scope leaves the plan provably untouched', () => {
    const plan = [scoped('code', ['src/a.js'])];
    const { scopes, withheldAssignments } = planScopes(plan, ['src/a.js'], ['build/out.js']);
    assert.equal(scopes, plan);
    assert.deepEqual(withheldAssignments, []);
  });

  test('PR material carries the withheld set as its own field, ready for the boundary', () => {
    const { reviewed, excluded } = filterFiles(FILES, ['build/**', '*.lock']);
    const material = buildPrMaterial({ files: reviewed, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT, excluded });
    assert.deepEqual(material.withheldPaths, ['build/out.js', 'deps.lock']);
  });
});

// One renderer for every sink that shows a withheld set — the prompts, the operator log, and the plan
// boundary's warning. Two sinks rendering the same set their own way is two truncation contracts.
describe('excludedPathList — the one bounded rendering', () => {
  test('names a short list in full and adds no tail', () => {
    assert.equal(excludedPathList(['a.js', 'b.js']), 'a.js, b.js');
  });

  test('caps a long list and states the remainder rather than dropping it', () => {
    const rendered = excludedPathList(Array.from({ length: 23 }, (_, i) => `f${i}.js`));
    assert.match(rendered, /^f0\.js, /);
    assert.match(rendered, /f19\.js \(and 3 more\)$/);
    assert.ok(!rendered.includes('f20.js'));
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
