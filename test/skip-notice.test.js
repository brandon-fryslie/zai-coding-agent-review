'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  announceNotReviewed, renderNotReviewedBody, parseAgentArtifact, summarizePriorReviews,
  forkNotice, roundCapNotice, submitReview, gitHubTransport,
  NOT_REVIEWED_MESSAGE, NOT_REVIEWED_REASONS, NOT_REVIEWED_MARKER_PREFIX, REVIEW_MARKER,
} = require('../src/transport');

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
const CAP_MESSAGE = `PR #${PR} has already been reviewed 5 time(s), reaching the MAX_REVIEW_ROUNDS cap `
  + 'of 5. Raise MAX_REVIEW_ROUNDS (0 = unlimited) to review further pushes.';
// The message a de-rating budget gradient would compose for the SAME reason on a later push.
const DERATED_MESSAGE = `PR #${PR} has already been reviewed 5 time(s), reaching the de-rated round cap `
  + 'of 3 set by the DAILY_BUDGET_USD gradient. To review further pushes, raise the daily budget.';

const announce = (octokit, notice, commitId = 'sha') => announceNotReviewed(octokit, {
  owner: 'o', repo: 'r', pullNumber: PR, commitId, reviewerName: 'RA', notice,
});

// One capped push: read the PR's current state, then announce — exactly the sequence runPrReview runs.
async function cappedPush(pr, commitId, message = CAP_MESSAGE) {
  const prior = await summarizePriorReviews(pr.octokit, 'o', 'r', PR);
  return announce(pr.octokit, roundCapNotice(message, prior.latestArtifact), commitId);
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
    assert.equal(parseAgentArtifact(notice.body).kind, 'not-reviewed');
    assert.equal(parseAgentArtifact(notice.body).reason, 'round-cap');
    assert.deepEqual(parseAgentArtifact(approved.body), { kind: 'review' });

    // A PERSON can tell them apart: the notice leads with NOT REVIEWED, names its cause and its remedy,
    // and shares no vocabulary with the approval it must never be mistaken for.
    assert.ok(notice.body.includes(NOT_REVIEWED_MESSAGE));
    assert.ok(notice.body.includes(CAP_MESSAGE));
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
    assert.equal(prior.latestArtifact.kind, 'not-reviewed');
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

  test('a notice whose CONTENT changed re-posts, though its reason did not', async () => {
    // The budget gradient starts binding on a later push: same reason, materially different cap number
    // and remedy. Keying on the reason alone left the operator reading a stale notice naming
    // MAX_REVIEW_ROUNDS when the daily budget was what actually bound.
    const pr = fakePr();
    assert.equal(await cappedPush(pr, 'sha1', CAP_MESSAGE), 'posted');
    assert.equal(await cappedPush(pr, 'sha2', DERATED_MESSAGE), 'posted');
    assert.equal(pr.reviews.length, 2);
    assert.ok(pr.reviews[1].body.includes('raise the daily budget'));
    // ...and the new content then de-duplicates against itself like any other.
    assert.equal(await cappedPush(pr, 'sha3', DERATED_MESSAGE), 'already-posted');
  });

  test('a post the host refuses warns loudly and never throws', async () => {
    const octokit = {
      rest: {
        pulls: {
          createReview: async () => { throw new Error('Resource not accessible by integration'); },
        },
      },
    };
    assert.equal(await announce(octokit, forkNotice(PR)), 'failed');
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
      () => announce(pr.octokit, { reason: 'typo-reason', message: 'x', latestArtifact: null }),
      /Unknown not-reviewed reason/,
    );
    assert.equal(pr.reviews.length, 0);
  });

  test('the newest artifact is the highest review id, whatever order the pages arrive in', async () => {
    // Every other output of summarizePriorReviews is an order-independent sum. Reading the latest off
    // arrival order would rest on an ordering GitHub documents and Gitea does not.
    const notice = renderNotReviewedBody('RA', roundCapNotice(CAP_MESSAGE, null));
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

describe('the notice value carries what differs, so no call site can pair it wrong', () => {
  // The reason, the trust key, and the post-failure hint were three arguments assembled by hand at two
  // call sites, tied together by nothing. These assert the pairing itself rather than a mock of it.
  test('forkNotice takes no key and yields none — there is no parameter to get wrong', () => {
    const n = forkNotice(PR);
    assert.equal(n.reason, NOT_REVIEWED_REASONS.FORK);
    assert.equal(n.latestArtifact, null);
    assert.equal(forkNotice.length, 1); // (pullNumber) — a key cannot be passed in
  });

  test('roundCapNotice carries the key it was given', () => {
    const key = { kind: 'not-reviewed', reason: 'round-cap', body: 'x' };
    const n = roundCapNotice(CAP_MESSAGE, key);
    assert.equal(n.reason, NOT_REVIEWED_REASONS.ROUND_CAP);
    assert.equal(n.latestArtifact, key);
  });

  test('each notice carries its own post-failure remedy, and neither names the other\'s cause', () => {
    // A round cap is only ever reached on a same-repo PR — forks are gated out before they can
    // accumulate rounds — so fork advice on that failure names a cause that cannot apply.
    assert.doesNotMatch(roundCapNotice(CAP_MESSAGE, null).postFailureHint, /workflow_run|fork PR/);
    assert.match(roundCapNotice(CAP_MESSAGE, null).postFailureHint, /pull-requests: write/);
  });

  test('the fork remedy names the trigger it depends on rather than asserting one', () => {
    // prIsFromFork reads the PR's repos, not the event, so this path is reached under workflow_run
    // too — where secrets ARE available. A hint that asserted the secrets cause would tell a
    // maintainer already on workflow_run to switch to workflow_run.
    const hint = forkNotice(PR).postFailureHint;
    assert.match(hint, /If this ran on a `pull_request` trigger/);
    assert.match(hint, /If you are already on workflow_run/);
    assert.match(hint, /pull-requests: write/); // the other branch stays actionable
  });
});

describe('an untrusted PR cannot silence its own notice', () => {
  test('a forged notice already on the PR does not suppress the real one', async () => {
    const pr = fakePr();
    // The PR author plants a body carrying the action's own fork marker.
    pr.reviews.push({ id: 99, body: `nothing to see here\n\n${NOT_REVIEWED_MARKER_PREFIX}fork -->` });
    // It parses as an artifact — the reader cannot tell forged from genuine, which is the open problem
    // tracked as zai-review-trust-6yp.
    const prior = await summarizePriorReviews(pr.octokit, 'o', 'r', PR);
    assert.equal(prior.latestArtifact.reason, 'fork');
    // forkNotice never consults it, so the real notice lands anyway.
    assert.equal(await announce(pr.octokit, forkNotice(PR)), 'posted');
    assert.equal(pr.reviews.length, 2);
    assert.ok(pr.reviews[1].body.includes(NOT_REVIEWED_MESSAGE));
  });

  test('the accepted cost: a fork notice repeats on every push, and that is the safe direction', async () => {
    const pr = fakePr();
    assert.equal(await announce(pr.octokit, forkNotice(PR), 'sha1'), 'posted');
    assert.equal(await announce(pr.octokit, forkNotice(PR), 'sha2'), 'posted');
    assert.equal(pr.reviews.length, 2);
  });
});

describe('parseAgentArtifact', () => {
  // The accept/reject table. The load-bearing row is the last pair: the two markers must be structurally
  // incapable of matching each other, since that — not a rule anyone remembers — is what keeps a notice
  // out of the round count and the cost tally.
  test('separates a round, a notice, and everything this action did not write', () => {
    assert.deepEqual(parseAgentArtifact(`verdict\n\n${REVIEW_MARKER}`), { kind: 'review' });
    assert.deepEqual(parseAgentArtifact(`verdict\n\n${REVIEW_MARKER}\n `), { kind: 'review' });
    assert.equal(parseAgentArtifact('x\n\n<!-- copirate-code-review-agent:not-reviewed:round-cap -->').reason, 'round-cap');
    assert.equal(parseAgentArtifact('x\n\n<!-- copirate-code-review-agent:not-reviewed:fork -->\n').reason, 'fork');
    assert.equal(parseAgentArtifact('a human review'), null);
    assert.equal(parseAgentArtifact(null), null);
    assert.equal(parseAgentArtifact(undefined), null);
    // Quoted mid-body by a human: the trailing-sentinel rule refuses both arms, as it always has.
    assert.equal(parseAgentArtifact(`I see ${REVIEW_MARKER} in the log`), null);
    assert.equal(parseAgentArtifact('quoting <!-- copirate-code-review-agent:not-reviewed:fork --> here'), null);
  });

  test('a notice arm carries its body, which is what the idempotency key compares', () => {
    const body = renderNotReviewedBody('RA', roundCapNotice(CAP_MESSAGE, null));
    assert.equal(parseAgentArtifact(body).body, body);
    assert.notEqual(
      parseAgentArtifact(renderNotReviewedBody('RA', roundCapNotice(DERATED_MESSAGE, null))).body,
      body,
    );
  });

  test('a notice marker can never satisfy the review-round sentinel', () => {
    const notice = renderNotReviewedBody('RA', roundCapNotice(CAP_MESSAGE, null));
    assert.equal(notice.trimEnd().endsWith(REVIEW_MARKER), false);
    assert.equal(parseAgentArtifact(notice).kind, 'not-reviewed');
  });
});
