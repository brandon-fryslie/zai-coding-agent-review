'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseReviewerName, DEFAULT_REVIEWER_NAME,
  submitReview, renderNotReviewedBody, roundCapNotice, gitHubTransport,
} = require('../src/transport');
const { renderRepoReport } = require('../src/report');

// The value a workflow actually delivers when it wires the input to an unset repo variable:
// `${{ vars.ZAI_REVIEWER_NAME }}` interpolates to "" and the runner passes it as a PROVIDED empty
// value, so core.getInput returns '' and action.yml's default is never consulted. Naming the shape
// keeps every case below anchored to the live defect (PR #117) rather than to a made-up input.
const UNSET_REPO_VARIABLE = '';

describe('parseReviewerName', () => {
  // [LAW:parse-dont-validate] The blank family is one shape, not three cases: '' (an unset repo
  // variable), whitespace (a workflow typo), and an omitted input all mean "the consumer did not
  // name the reviewer", and all leave this boundary as the one documented name.
  for (const [label, raw] of [
    ['an unset repo variable', UNSET_REPO_VARIABLE],
    ['whitespace only', '   '],
    ['a tab', '\t'],
    ['an omitted input', undefined],
  ]) {
    test(`${label} resolves to the documented default`, () => {
      assert.equal(parseReviewerName(raw), DEFAULT_REVIEWER_NAME);
    });
  }

  // The default is the name README documents for an unspecified input; asserting the literal makes
  // this test the check that the two stay in step. [LAW:one-source-of-truth]
  test('the default is the name README documents', () => {
    assert.equal(DEFAULT_REVIEWER_NAME, 'CoPirate Code Review');
  });

  test('a consumer-supplied name is carried through, trimmed', () => {
    assert.equal(parseReviewerName('  Acme Reviewer  '), 'Acme Reviewer');
  });

  // A name that merely CONTAINS the default must not be confused with the default; the resolution
  // reads emptiness, never content.
  test('a name is never rewritten to the default', () => {
    assert.equal(parseReviewerName('CoPirate Code Review (staging)'), 'CoPirate Code Review (staging)');
  });
});

// The defect this fixes was invisible in the parse and visible only on the PR: every artifact this
// action posts opens with `## ${reviewerName}`, so a blank published a dangling `## ` heading —
// observed live on PR #117 in BOTH artifact kinds. These drive the REAL renderers with the name the
// REAL boundary produces, so a sink that grows its own header, or a boundary that stops resolving,
// fails here. [LAW:behavior-not-structure] the contract is what lands on the PR, not how it is built.
describe('no artifact opens with a nameless heading', () => {
  const resolved = parseReviewerName(UNSET_REPO_VARIABLE);
  const DANGLING_HEADING = /^##\s*$/m;

  function fakePr() {
    const reviews = [];
    return {
      reviews,
      octokit: { rest: { pulls: { createReview: async params => { reviews.push(params); } } } },
    };
  }

  test('a submitted PR review is headed by the resolved name', async () => {
    const pr = fakePr();
    await submitReview(pr.octokit, 'o', 'r', 7, 'sha', resolved, {
      summary: 'Nothing found.', findings: [], unreviewedScopes: [], unreviewableFiles: [],
    }, true, gitHubTransport([], []));
    assert.match(pr.reviews[0].body, /^## CoPirate Code Review\n/);
    assert.doesNotMatch(pr.reviews[0].body, DANGLING_HEADING);
  });

  test('a NOT REVIEWED notice is headed by the resolved name', () => {
    const body = renderNotReviewedBody(resolved, roundCapNotice('capped', null));
    assert.match(body, /^## CoPirate Code Review\n/);
    assert.doesNotMatch(body, DANGLING_HEADING);
  });

  test('a whole-repo report is headed by the resolved name', () => {
    const report = renderRepoReport({
      reviewerName: resolved, scope: '', review: { summary: 'Clean.', findings: [] }, footer: '',
    });
    assert.match(report, /^## CoPirate Code Review — Full-repository review\n/);
    assert.doesNotMatch(report, DANGLING_HEADING);
  });
});
