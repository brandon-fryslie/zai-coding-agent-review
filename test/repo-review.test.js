'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewInput, buildRepoReviewInput } = require('../src/prompt');
const { renderRepoReport, groupByPath } = require('../src/report');

const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
};

const REPO_ROOT = '/home/runner/work/acme/acme';

// --- buildRepoReviewInput (the full-repo MATERIAL) ---

describe('buildRepoReviewInput', () => {
  test('injects a non-empty scope as a focus instruction', () => {
    const { prompt } = buildRepoReviewInput({ scope: 'the auth layer', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /Focus this review on the following scope[^]*the auth layer/);
    assert.doesNotMatch(prompt, /broad review across the whole repository/);
  });

  test('empty scope renders the broad whole-repo instruction, not an empty focus', () => {
    const { prompt } = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /broad review across the whole repository/);
    assert.doesNotMatch(prompt, /Focus this review on the following scope/);
  });

  test('forwards the engine tool identifiers, never hardcoded names', () => {
    const custom = { requestChange: 'tool_rc', finishReview: 'tool_fr' };
    const { prompt } = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: custom, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /tool_rc/);
    assert.match(prompt, /tool_fr/);
    assert.doesNotMatch(prompt, /mcp__review_collector__request_change/);
  });

  test('lists exclude patterns when present and omits the line when empty', () => {
    const withExcludes = buildRepoReviewInput({ scope: '', excludePatterns: ['*.lock', 'dist/**'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.match(withExcludes, /Do NOT review files matching these excluded patterns: \*\.lock, dist\/\*\*\./);

    const noExcludes = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.doesNotMatch(noExcludes, /excluded patterns/);
  });

  test('frames pre-existing issues as in scope (the inverse of PR-diff review) and carries no diff grid', () => {
    const { prompt } = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /PRE-EXISTING issues in any file ARE in scope/);
    assert.match(prompt, /any line is valid/);
    assert.doesNotMatch(prompt, /LINE N/);
  });

  test('names the reviewed repo by absolute path and states cwd is outside it (instruction-injection guard)', () => {
    const { prompt } = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /checked out\s+at \/home\/runner\/work\/acme\/acme/);
    assert.match(prompt, /working directory is intentionally outside the repository/);
  });

  test('returns no files/anchors surface — only a prompt', () => {
    const result = buildRepoReviewInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.deepEqual(Object.keys(result), ['prompt']);
  });
});

// --- buildReviewInput (the PR-diff MATERIAL) — repo-root anchoring ---

describe('buildReviewInput repo-root anchoring', () => {
  const FILES = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];

  test('names the reviewed repo by absolute path and states cwd is outside it', () => {
    const { prompt } = buildReviewInput({ files: FILES, maxDiffChars: 0, toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT });
    assert.match(prompt, /checked out at \/home\/runner\/work\/acme\/acme/);
    assert.match(prompt, /working directory is intentionally outside the repository/);
  });
});

// --- renderRepoReport (the printed SINK) ---

const REVIEW_WITH_FINDINGS = {
  summary: 'Two issues across the data layer.',
  findings: [
    { path: 'src/b.js', line: 5, body: 'first b finding' },
    { path: 'src/a.js', line: 40, body: 'late a finding' },
    { path: 'src/a.js', line: 10, body: 'early a finding' },
  ],
};

describe('renderRepoReport', () => {
  test('groups findings by file, lines ascending, first-seen path order preserved', () => {
    const report = renderRepoReport({ reviewerName: 'My Reviewer', scope: '', review: REVIEW_WITH_FINDINGS, footer: '' });
    assert.match(report, /## My Reviewer — Full-repository review/);
    assert.match(report, /### Findings \(3\)/);
    // b precedes a (first-seen order), and within a, line 10 precedes line 40 (ascending).
    const bIdx = report.indexOf('#### src/b.js');
    const aIdx = report.indexOf('#### src/a.js');
    assert.ok(bIdx > -1 && aIdx > -1 && bIdx < aIdx, 'b group before a group');
    assert.ok(report.indexOf('early a finding') < report.indexOf('late a finding'), 'lines ascending within a file');
    assert.match(report, /- \*\*line 10:\*\* early a finding/);
  });

  test('renders the scope line from a non-empty scope', () => {
    const report = renderRepoReport({ reviewerName: 'R', scope: 'the auth layer', review: REVIEW_WITH_FINDINGS, footer: '' });
    assert.match(report, /\*\*Scope:\*\* the auth layer/);
  });

  test('empty scope renders "whole repository"', () => {
    const report = renderRepoReport({ reviewerName: 'R', scope: '', review: REVIEW_WITH_FINDINGS, footer: '' });
    assert.match(report, /\*\*Scope:\*\* whole repository/);
  });

  test('no findings renders the No findings section, not an empty list', () => {
    const report = renderRepoReport({ reviewerName: 'R', scope: '', review: { summary: 'Clean.', findings: [] }, footer: '' });
    assert.match(report, /\*\*No findings\.\*\*/);
    assert.doesNotMatch(report, /### Findings/);
  });

  test('appends the footer when present and omits it when empty', () => {
    const withFooter = renderRepoReport({ reviewerName: 'R', scope: '', review: REVIEW_WITH_FINDINGS, footer: '_Reviewed by x · est._' });
    assert.match(withFooter, /_Reviewed by x · est\._\s*$/);

    const noFooter = renderRepoReport({ reviewerName: 'R', scope: '', review: REVIEW_WITH_FINDINGS, footer: '' });
    assert.doesNotMatch(noFooter, /Reviewed by/);
  });

  test('flattens multi-line finding bodies to a single scannable line', () => {
    const review = { summary: 's', findings: [{ path: 'f.js', line: 1, body: 'line one\n  line two\nline three' }] };
    const report = renderRepoReport({ reviewerName: 'R', scope: '', review, footer: '' });
    assert.match(report, /- \*\*line 1:\*\* line one line two line three/);
  });

  test('renders every finding body verbatim — there is no severity tag', () => {
    const review = {
      summary: 's',
      findings: [
        { path: 'f.js', line: 1, body: 'must fix' },
        { path: 'f.js', line: 2, body: 'nice to have' },
      ],
    };
    const report = renderRepoReport({ reviewerName: 'R', scope: '', review, footer: '' });
    assert.match(report, /- \*\*line 1:\*\* must fix/);
    assert.match(report, /- \*\*line 2:\*\* nice to have/);
    assert.doesNotMatch(report, /Advisory/);
  });
});

describe('groupByPath', () => {
  test('preserves first-seen path order and sorts lines ascending within each file', () => {
    const grouped = groupByPath([
      { path: 'z.js', line: 9, body: 'a' },
      { path: 'a.js', line: 3, body: 'b' },
      { path: 'z.js', line: 1, body: 'c' },
    ]);
    assert.deepEqual([...grouped.keys()], ['z.js', 'a.js']);
    assert.deepEqual(grouped.get('z.js').map(f => f.line), [1, 9]);
  });
});
