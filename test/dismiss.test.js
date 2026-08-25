'use strict';

// The dismiss-block action (itv.4.1): a small, SEPARATE entrypoint from run.js's own review path,
// shipped specifically so a Gitea-only credential never becomes an input on the review action every
// GitHub consumer shares. These tests are about routing: DISMISS_TOKEN must be the credential that
// actually makes the dismissal call, never the read-level GITHUB_TOKEN/GITHUB_REVIEW_TOKEN, and a PR
// with nothing outstanding must be a true no-op (safe to run unconditionally on every PR event).

process.env.GITHUB_REPOSITORY = 'acme/widget';
process.env.GITHUB_WORKSPACE = '/home/runner/work/widget/widget';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const core = require('@actions/core');
const github = require('@actions/github');
const { REVIEW_MARKER, NOT_REVIEWED_MARKER_PREFIX, NOT_REVIEWED_REASONS } = require('../src/transport');

// A round-cap-blocked review is one THIS action posted (summarizePriorReviews only ever collects a
// review whose body carries REVIEW_MARKER into its outstanding-block candidate set) — a human
// reviewer's REQUEST_CHANGES has no marker and is invisible to this action by construction.
const ourBlock = (id, state) => ({ id, state, body: `Findings here.\n${REVIEW_MARKER}` });

// The review action's round-cap NOTICE — the record, on the PR, that it has given up on this PR and
// will not supersede the block above. Built from the same constants the notice renderer writes with, so
// a marker rename moves both together instead of leaving this suite asserting a dead spelling.
// Its ID must exceed the block's: "newest artifact" is the highest review id, not arrival order.
const capNotice = id => ({
  id,
  state: 'COMMENTED',
  body: `Not reviewed.\n\n${NOT_REVIEWED_MARKER_PREFIX}${NOT_REVIEWED_REASONS.ROUND_CAP} -->`,
});

let reviews;
// Calls the write-level credential made vs. the admin-level one — the whole point under test.
let writeCalls;
let adminCalls;

// One shared `reviews` store, read and written by whichever token's fake calls it — the same shape a
// live Gitea PR has one truth regardless of which of this action's credentials is asking.
function fakeOctokitFor(token) {
  return {
    rest: {
      pulls: {
        // A single already-patched file is enough to resolve selectTransport to gitHubTransport
        // (PUT .../dismissals) — this suite is about credential ROUTING, which is host-agnostic; the
        // host-detection and Gitea-route behavior are already covered in test/skip-notice.test.js.
        listFiles: async ({ page }) => ({ data: page === 1 ? [{ filename: 'a.js', status: 'modified', patch: '@@ -0,0 +1 @@\n+x' }] : [] }),
        listReviews: async ({ page }) => ({ data: page === 1 ? reviews : [] }),
        createReview: async params => {
          const posted = { id: reviews.length + 1, state: 'COMMENT', body: params.body };
          reviews.push(posted);
          return { data: posted };
        },
      },
    },
    request: async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}') {
        const found = reviews.find(r => r.id === params.review_id);
        if (!found) throw new Error(`404 no review ${params.review_id}`);
        return { data: found };
      }
      if (route === 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals') {
        const target = reviews.find(r => r.id === params.review_id);
        if (!target) throw new Error(`404 no review ${params.review_id}`);
        if (token === 'admin-token') {
          adminCalls.push(params);
          target.state = 'DISMISSED';
          return { data: target };
        }
        writeCalls.push(params);
        throw new Error("403 Forbidden: doer's Permission denied, needs repo Admin");
      }
      throw new Error(`404 Not Found: no route "${route}" for token ${token}`);
    },
  };
}

beforeEach(() => {
  reviews = [];
  writeCalls = [];
  adminCalls = [];
});

github.getOctokit = token => fakeOctokitFor(token);
github.context = { repo: { owner: 'acme', repo: 'widget' }, payload: {} };

const { run } = require('../src/dismiss');

function setInputs(overrides = {}) {
  const defaults = {
    INPUT_GITHUB_TOKEN: 'gh-token',
    INPUT_GITHUB_REVIEW_TOKEN: 'gh-token',
    INPUT_DISMISS_TOKEN: 'admin-token',
    INPUT_PR_NUMBER: '7',
    INPUT_HEAD_SHA: 'head-sha',
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function runCapturingFailures() {
  const said = [];
  const realSetFailed = core.setFailed;
  core.setFailed = m => said.push(m);
  try {
    await run();
  } finally {
    core.setFailed = realSetFailed;
  }
  return said;
}

describe('the dismiss-block action', () => {
  test('dismisses an outstanding block with DISMISS_TOKEN, never the write-level token', async () => {
    setInputs();
    reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 1, 'the admin credential made the dismissal call');
    assert.equal(writeCalls.length, 0, 'the write-level credential was never asked to dismiss');
    assert.equal(reviews[0].state, 'DISMISSED');
  });

  test('a PR with nothing outstanding is a silent no-op — safe to run on every push', async () => {
    setInputs();
    reviews.push(ourBlock(5, 'COMMENTED'), capNotice(6));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0);
    assert.equal(writeCalls.length, 0);
  });

  // The bug this gate exists to prevent. `if: always()` puts this action directly after the review step,
  // so on a normal round it is looking at a REQUEST_CHANGES posted seconds ago for real, unaddressed
  // findings — "still blocking" in exactly the same way a round-cap leftover is. Releasing on
  // outstanding-ness alone would dismiss it, defeating block_merge_on_rejected_reviews on every push that
  // draws findings. The review is the newest artifact here, so the reviewer has NOT given up on this PR.
  test('leaves a live block alone when the review action has not declined to revisit the PR', async () => {
    setInputs();
    reviews.push(ourBlock(101, 'CHANGES_REQUESTED'));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0, 'a block the reviewer still intends to supersede is never dismissed');
    assert.equal(writeCalls.length, 0);
    assert.equal(reviews[0].state, 'CHANGES_REQUESTED', 'still blocking — the merge gate is intact');
  });

  // The cap was raised (or the de-rating lifted) and a real round landed afterwards: the notice is no
  // longer the last word, so the reviewer is back to superseding its own blocks and this action stands down.
  test('stands down once a real review round supersedes the round-cap notice', async () => {
    setInputs();
    reviews.push(capNotice(50), ourBlock(101, 'CHANGES_REQUESTED'));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0);
    assert.equal(reviews[1].state, 'CHANGES_REQUESTED');
  });

  // The round-cap notice failed to post, so run.js returned before releasing anything and no explanation
  // reached the PR. The dismissal message asserts that an explanation IS on the PR, so this state must be
  // unreachable from it — otherwise that false claim lands permanently in the PR's review history.
  test('releases nothing when no round-cap notice ever reached the PR', async () => {
    setInputs();
    reviews.push(ourBlock(100, 'CHANGES_REQUESTED'), ourBlock(101, 'CHANGES_REQUESTED'));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0, 'the message pointing at a notice is never posted without one');
  });

  test('a PR with no reviews at all is a silent no-op', async () => {
    setInputs();
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0);
  });

  test('DISMISS_TOKEN is required — a run without it fails loud rather than silently skipping', async () => {
    setInputs({ INPUT_DISMISS_TOKEN: '' });
    reviews.push(ourBlock(101, 'CHANGES_REQUESTED'));
    const said = await runCapturingFailures();
    assert.equal(said.length, 1);
    assert.match(said[0], /DISMISS_TOKEN is required/);
    assert.equal(adminCalls.length, 0);
    assert.equal(writeCalls.length, 0, 'never falls back to attempting the dismissal with a lesser credential');
  });

  test('a refused dismissal reds the run and names the still-blocking review', async () => {
    setInputs({ INPUT_DISMISS_TOKEN: 'gh-token' }); // not the admin token — refused, same as write access
    reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102));
    const said = await runCapturingFailures();
    assert.equal(said.length, 1);
    assert.match(said[0], /101/);
    assert.equal(reviews[0].state, 'CHANGES_REQUESTED', 'still blocking — the refused call changed nothing');
  });
});
