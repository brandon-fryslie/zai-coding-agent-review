'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  announceNotReviewed, renderNotReviewedBody, parseAgentArtifact, summarizePriorReviews,
  submitReview, gitHubTransport, NOT_REVIEWED_MESSAGE, NOT_REVIEWED_REASONS, REVIEW_MARKER,
} = require('../src/transport');
const { latestArtifactBestEffort } = require('../src/run');

// A fake pull request: createReview appends, listReviews serves back exactly what was posted, in order.
// Driving the producer (announceNotReviewed / submitReview) and the reader (summarizePriorReviews)
// against ONE store makes these ROUND-TRIP tests. A marker the sink writes and the reader cannot parse
// fails here — which is precisely the drift a hand-written fixture string would hide, and the drift the
// whole "a skip must be distinguishable" contract rests on. [LAW:behavior-not-structure]
function fakePr() {
  const reviews = [];
  return {
    reviews,
    octokit: {
      rest: {
        pulls: {
          createReview: async params => { reviews.push({ id: reviews.length + 1, ...params }); },
          listReviews: async ({ page }) => ({ data: page === 1 ? reviews : [] }),
        },
      },
    },
  };
}

const PR = 7;
const CAP_NOTICE = {
  reason: NOT_REVIEWED_REASONS.ROUND_CAP,
  message: `PR #${PR} has already been reviewed 5 time(s), reaching the MAX_REVIEW_ROUNDS cap of 5. `
    + 'Raise MAX_REVIEW_ROUNDS (0 = unlimited) to review further pushes.',
};
const FORK_NOTICE = { reason: NOT_REVIEWED_REASONS.FORK, message: `PR #${PR} is from a fork.` };

// One capped push: read the PR's current state, then announce — exactly the sequence runPrReview runs.
async function cappedPush(pr, commitId, notice = CAP_NOTICE) {
  const prior = await summarizePriorReviews(pr.octokit, 'o', 'r', PR);
  return announceNotReviewed(pr.octokit, {
    owner: 'o', repo: 'r', pullNumber: PR, commitId, reviewerName: 'RA',
    notice, latestArtifact: prior.latestArtifact,
  });
}

// The real clean-review artifact, produced by the real sink — not a fixture — so "distinguishable from a
// clean review" is asserted against what a clean review actually posts today.
async function cleanReview() {
  const pr = fakePr();
  await submitReview(pr.octokit, 'o', 'r', PR, 'sha', 'RA', {
    summary: 'Nothing found.', findings: [], unreviewedScopes: [], unreviewableFiles: [],
  }, true, gitHubTransport([], []));
  return pr.reviews[0];
}

describe('a review-less run speaks at the PR', () => {
  test('a round-cap skip posts an artifact a clean review can never produce', async () => {
    const pr = fakePr();
    assert.equal(await cappedPush(pr, 'sha1'), 'posted');
    assert.equal(pr.reviews.length, 1);
    const notice = pr.reviews[0];
    const approved = await cleanReview();

    // A MACHINE can tell them apart: the two markers parse to different artifact kinds.
    assert.deepEqual(parseAgentArtifact(notice.body), { kind: 'not-reviewed', reason: 'round-cap' });
    assert.deepEqual(parseAgentArtifact(approved.body), { kind: 'review' });

    // A PERSON can tell them apart: the notice leads with NOT REVIEWED, names its cause and its remedy,
    // and shares no vocabulary with the approval it must never be mistaken for.
    assert.ok(notice.body.includes(NOT_REVIEWED_MESSAGE));
    assert.ok(notice.body.includes(CAP_NOTICE.message));
    assert.ok(notice.body.includes('MAX_REVIEW_ROUNDS'));
    assert.ok(!notice.body.includes('✅ Approved'));
    assert.ok(approved.body.includes('✅ Approved'));

    // The two shapes the ticket ruled out: the notice is never an approval and never a change request.
    assert.equal(notice.event, 'COMMENT');
    assert.equal(approved.event, 'APPROVE');
  });

  test('a second push while still capped posts no duplicate', async () => {
    const pr = fakePr();
    assert.equal(await cappedPush(pr, 'sha1'), 'posted');
    assert.equal(await cappedPush(pr, 'sha2'), 'already-posted');
    assert.equal(await cappedPush(pr, 'sha3'), 'already-posted');
    assert.equal(pr.reviews.length, 1);
  });

  test('a notice is never counted as a review round, so it cannot spend the cap it reports', async () => {
    const pr = fakePr();
    await cappedPush(pr, 'sha1');
    const prior = await summarizePriorReviews(pr.octokit, 'o', 'r', PR);
    assert.equal(prior.count, 0);
    assert.deepEqual(prior.reviewIds, []);
    assert.equal(prior.cost.billed.count, 0);
    assert.equal(prior.cost.billed.unknownCount, 0);
    assert.deepEqual(prior.latestArtifact, { kind: 'not-reviewed', reason: 'round-cap' });
  });

  test('raising the cap lets a real round land, and the NEXT cap speaks again', async () => {
    const pr = fakePr();
    assert.equal(await cappedPush(pr, 'sha1'), 'posted');
    // The operator raises MAX_REVIEW_ROUNDS; a real review round posts and becomes the last word.
    await submitReview(pr.octokit, 'o', 'r', PR, 'sha2', 'RA', {
      summary: 'Nothing found.', findings: [], unreviewedScopes: [], unreviewableFiles: [],
    }, true, gitHubTransport([], []));
    // The cap binds again. A per-PR "already told them" flag would stay silent here forever; keying on
    // "my notice is still the newest artifact" speaks, because it no longer is.
    assert.equal(await cappedPush(pr, 'sha3'), 'posted');
    assert.equal(pr.reviews.length, 3);
  });

  test('a different reason speaks even when a notice is already present', async () => {
    const pr = fakePr();
    assert.equal(await cappedPush(pr, 'sha1', CAP_NOTICE), 'posted');
    assert.equal(await cappedPush(pr, 'sha2', FORK_NOTICE), 'posted');
    assert.equal(await cappedPush(pr, 'sha3', FORK_NOTICE), 'already-posted');
    assert.equal(pr.reviews.length, 2);
  });

  test('a post the host refuses warns loudly and never throws', async () => {
    // A fork PR on a `pull_request` trigger gets a read-only token: createReview 403s and no
    // configuration fixes it. Reddening the run there would red every fork PR forever.
    const octokit = {
      rest: {
        pulls: {
          createReview: async () => { throw new Error('Resource not accessible by integration'); },
        },
      },
    };
    const outcome = await announceNotReviewed(octokit, {
      owner: 'o', repo: 'r', pullNumber: PR, commitId: 'sha', reviewerName: 'RA',
      notice: FORK_NOTICE, latestArtifact: null,
    });
    assert.equal(outcome, 'failed');
  });

  test('an unknown reason is refused at the boundary that would turn it into a marker', () => {
    assert.throws(
      () => renderNotReviewedBody('RA', { reason: 'whatever', message: 'x' }),
      /Unknown not-reviewed reason/,
    );
  });

  test('an unknown reason THROWS out of announceNotReviewed, never degrading to the host warning', async () => {
    // A programming error must not wear a transient error's costume. Rendering inside the try would have
    // caught this in the host-failure arm and reported a permissions problem on a run that exits 0.
    const pr = fakePr();
    await assert.rejects(
      () => announceNotReviewed(pr.octokit, {
        owner: 'o', repo: 'r', pullNumber: PR, commitId: 'sha', reviewerName: 'RA',
        notice: { reason: 'typo-reason', message: 'x' }, latestArtifact: null,
      }),
      /Unknown not-reviewed reason/,
    );
    assert.equal(pr.reviews.length, 0);
  });

  test('the newest artifact is the highest review id, whatever order the pages arrive in', async () => {
    // Every other output of summarizePriorReviews is an order-independent sum. Reading the latest off
    // arrival order would rest on an ordering GitHub documents and Gitea does not.
    const notice = renderNotReviewedBody('RA', CAP_NOTICE);
    const round = `verdict\n\n${REVIEW_MARKER}`;
    const descending = {
      rest: {
        pulls: {
          listReviews: async ({ page }) => ({
            data: page === 1 ? [{ id: 9, body: round }, { id: 4, body: notice }] : [],
          }),
        },
      },
    };
    // The round has the higher id, so it is the newest agent artifact even though the notice came last.
    const prior = await summarizePriorReviews(descending, 'o', 'r', PR);
    assert.deepEqual(prior.latestArtifact, { kind: 'review' });
  });
});

describe('the fork path never fails on its idempotency key', () => {
  test('a listReviews failure warns and yields null, so the notice still posts', async () => {
    // A fork PR is skipped from the `pr` object alone; nothing about that decision may depend on this
    // call. Failing open costs a repeated notice — failing closed would red a run that cannot fail.
    const octokit = {
      rest: { pulls: { listReviews: async () => { throw new Error('secondary rate limit'); } } },
    };
    assert.equal(await latestArtifactBestEffort(octokit, 'o', 'r', PR), null);
  });

  test('a healthy fetch still yields the key, so the fork notice de-duplicates normally', async () => {
    const pr = fakePr();
    await announceNotReviewed(pr.octokit, {
      owner: 'o', repo: 'r', pullNumber: PR, commitId: 'sha1', reviewerName: 'RA',
      notice: FORK_NOTICE, latestArtifact: null,
    });
    const key = await latestArtifactBestEffort(pr.octokit, 'o', 'r', PR);
    assert.deepEqual(key, { kind: 'not-reviewed', reason: 'fork' });
    const outcome = await announceNotReviewed(pr.octokit, {
      owner: 'o', repo: 'r', pullNumber: PR, commitId: 'sha2', reviewerName: 'RA',
      notice: FORK_NOTICE, latestArtifact: key,
    });
    assert.equal(outcome, 'already-posted');
    assert.equal(pr.reviews.length, 1);
  });
});

describe('parseAgentArtifact', () => {
  // The accept/reject table. The load-bearing row is the last pair: the two markers must be structurally
  // incapable of matching each other, since that — not a rule anyone remembers — is what keeps a notice
  // out of the round count and the cost tally.
  test('separates a round, a notice, and everything this action did not write', () => {
    assert.deepEqual(parseAgentArtifact(`verdict\n\n${REVIEW_MARKER}`), { kind: 'review' });
    assert.deepEqual(parseAgentArtifact(`verdict\n\n${REVIEW_MARKER}\n `), { kind: 'review' });
    assert.deepEqual(
      parseAgentArtifact('x\n\n<!-- copirate-code-review-agent:not-reviewed:round-cap -->'),
      { kind: 'not-reviewed', reason: 'round-cap' },
    );
    assert.deepEqual(
      parseAgentArtifact('x\n\n<!-- copirate-code-review-agent:not-reviewed:fork -->\n'),
      { kind: 'not-reviewed', reason: 'fork' },
    );
    assert.equal(parseAgentArtifact('a human review'), null);
    assert.equal(parseAgentArtifact(null), null);
    assert.equal(parseAgentArtifact(undefined), null);
    // Quoted mid-body by a human: the trailing-sentinel rule refuses both arms, as it always has.
    assert.equal(parseAgentArtifact(`I see ${REVIEW_MARKER} in the log`), null);
    assert.equal(parseAgentArtifact('quoting <!-- copirate-code-review-agent:not-reviewed:fork --> here'), null);
  });

  test('a notice marker can never satisfy the review-round sentinel', () => {
    const notice = renderNotReviewedBody('RA', CAP_NOTICE);
    assert.equal(notice.trimEnd().endsWith(REVIEW_MARKER), false);
    assert.equal(parseAgentArtifact(notice).kind, 'not-reviewed');
  });
});
