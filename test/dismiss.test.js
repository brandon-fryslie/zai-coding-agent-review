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

// The identity `reviewOctokit` (built from GITHUB_REVIEW_TOKEN, or its GITHUB_TOKEN fallback — see
// setInputs) resolves to via users.getAuthenticated() in these fixtures. A genuine round-cap notice is
// authored by this account; an attacker posting the same literal marker text is authored by ATTACKER_ID
// instead, which is exactly what a body-content-only check could not tell apart (itv-4-2 round 4).
const TRUSTED_BOT_ID = 999;
const ATTACKER_ID = 666;
const TRUSTED_USER = { id: TRUSTED_BOT_ID, login: 'copirate-bot' };

// A round-cap-blocked review is one THIS action posted (summarizePriorReviews only ever collects a
// review whose body carries REVIEW_MARKER into its outstanding-block candidate set) — a human
// reviewer's REQUEST_CHANGES has no marker and is invisible to this action by construction.
// It carries the trusted author because every real review has one, and since the author gate the
// review action applies, a review with no `user` is unattributable and correctly collected by nobody.
const ourBlock = (id, state) => ({ id, state, user: TRUSTED_USER, body: `Findings here.\n${REVIEW_MARKER}` });

// The review action's round-cap NOTICE — the record, on the PR, that it has given up on this PR and
// will not supersede the block above. Built from the same constants the notice renderer writes with, so
// a marker rename moves both together instead of leaving this suite asserting a dead spelling.
// Its ID must exceed the block's: "newest artifact" is the highest review id, not arrival order.
// `authorId` defaults to the trusted bot — a genuine notice — and is overridden to ATTACKER_ID by the
// forgery tests below, which is the ONLY thing that differs between a real notice and a forged one.
const capNotice = (id, authorId = TRUSTED_BOT_ID) => ({
  id,
  state: 'COMMENTED',
  user: authorId === TRUSTED_BOT_ID ? TRUSTED_USER : { id: authorId, login: 'attacker' },
  body: `Not reviewed.\n\n${NOT_REVIEWED_MARKER_PREFIX}${NOT_REVIEWED_REASONS.ROUND_CAP} -->`,
});

let reviews;
// Calls the write-level credential made vs. the admin-level one — the whole point under test.
let writeCalls;
let adminCalls;
// The PR object `pulls.get` returns — same-repo (not a fork) by default, so every routing test
// above reaches its normal path unchanged; the fork test overrides this to a cross-repo PR.
let prFixture;
// What GET /user (users.getAuthenticated) answers for the 'gh-token' identity — the credential
// GITHUB_REVIEW_TOKEN/GITHUB_TOKEN resolves to by default in setInputs, and so the identity dismiss.js
// asks "who am I" as before trusting any round-cap notice. A test that wants the whoami call itself to
// fail (a transient host error, not a forgery) sets this to a thrown Error instead of an id object.
let whoami;

// One shared `reviews` store, read and written by whichever token's fake calls it — the same shape a
// live Gitea PR has one truth regardless of which of this action's credentials is asking.
function fakeOctokitFor(token) {
  return {
    rest: {
      pulls: {
        get: async () => ({ data: prFixture }),
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
      users: {
        // Only ever called on the token dismiss.js builds `reviewOctokit` from — TRUSTED_BOT_ID for
        // 'gh-token', the default in setInputs. A test asking for a different token gets an error, so a
        // whoami call made against the wrong credential fails loudly instead of quietly answering anyway.
        getAuthenticated: async () => {
          if (whoami instanceof Error) throw whoami;
          if (token !== 'gh-token') throw new Error(`401 Unauthorized: no such identity for token ${token}`);
          return { data: whoami };
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
  prFixture = { head: { repo: { id: 100 } }, base: { repo: { id: 100 } } };
  whoami = { id: TRUSTED_BOT_ID, login: 'copirate-bot' };
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

  // The bug: a fork PR gets no repository secrets (GITHUB_TOKEN is the one exception, and it arrives
  // read-only), so DISMISS_TOKEN resolves to '' there — matching GITHUB_REVIEW_TOKEN, per
  // transport.js's forkNotice comment. That must be a clean no-op, not the misconfiguration failure
  // below, since dismiss-block/README.md documents this action running unconditionally on every PR
  // event, fork PRs included.
  test('a fork PR with no DISMISS_TOKEN is a clean no-op, not a failure', async () => {
    setInputs({ INPUT_DISMISS_TOKEN: '' });
    prFixture = { head: { repo: { id: 200 } }, base: { repo: { id: 100 } } };
    reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102));
    const said = await runCapturingFailures();
    assert.deepEqual(said, []);
    assert.equal(adminCalls.length, 0);
    assert.equal(writeCalls.length, 0);
    assert.equal(reviews[0].state, 'CHANGES_REQUESTED', 'a fork PR is never touched — nothing dismissed');
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

  // itv-4-2 round 4: hasDeclinedRevisit used to trust the round-cap marker from body content alone. On a
  // public repo any account with read access can post a review ending in the same literal marker text —
  // these four tests are that attack, and the identity check that closes it.
  describe('a forged round-cap notice must not release a genuinely outstanding block', () => {
    test('a notice posted by an untrusted account is not treated as the review action giving up', async () => {
      setInputs();
      // Same marker text a genuine notice carries, but authored by someone other than the identity
      // GITHUB_REVIEW_TOKEN resolves to — exactly what an attacker with read access can produce.
      reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102, ATTACKER_ID));
      const said = await runCapturingFailures();
      assert.deepEqual(said, []);
      assert.equal(adminCalls.length, 0, 'a forged notice never authorizes the Admin-level dismissal');
      assert.equal(writeCalls.length, 0);
      assert.equal(reviews[0].state, 'CHANGES_REQUESTED', 'the real block stays up');
    });

    test('a genuine notice from the trusted identity still releases the block', async () => {
      setInputs();
      reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102)); // defaults to TRUSTED_BOT_ID
      const said = await runCapturingFailures();
      assert.deepEqual(said, []);
      assert.equal(adminCalls.length, 1, 'a real round-cap notice, correctly attributed, still releases');
      assert.equal(reviews[0].state, 'DISMISSED');
    });

    // A review with no `user` at all (a malformed or stripped payload) must not be treated as a wash with
    // an equally-absent trusted id — both being undefined must never read as a match.
    test('a notice with no author information is not trusted either', async () => {
      setInputs();
      const notice = capNotice(102);
      delete notice.user;
      reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), notice);
      const said = await runCapturingFailures();
      assert.deepEqual(said, []);
      assert.equal(adminCalls.length, 0);
      assert.equal(reviews[0].state, 'CHANGES_REQUESTED');
    });

    // If this run cannot establish its own identity, it must not fall back to trusting the notice's body
    // content — the exact behavior this whole gate exists to remove. The safe failure is "release nothing".
    test('a failed identity lookup leaves the block up rather than falling back to trusting body content', async () => {
      setInputs();
      whoami = new Error('503 Service Unavailable');
      reviews.push(ourBlock(101, 'CHANGES_REQUESTED'), capNotice(102));
      const said = await runCapturingFailures();
      assert.deepEqual(said, [], 'a whoami failure is a warning, not a run failure');
      assert.equal(adminCalls.length, 0);
      assert.equal(reviews[0].state, 'CHANGES_REQUESTED');
    });
  });
});
