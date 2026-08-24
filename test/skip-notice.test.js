'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('@actions/core');
const {
  announceNotReviewed, renderNotReviewedBody, parseAgentArtifact, summarizePriorReviews,
  releaseUnrevisitableBlocks, isOutstandingBlock, giteaTransport,
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
    assert.deepEqual(prior.reviews, []);
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

  // Scoped to the FORK notice deliberately: since severity became a carried value, "a refused post warns"
  // is true of this notice, not of the mechanism. The round cap's opposite is asserted below.
  test('a FORK post the host refuses warns loudly and never throws', async () => {
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
    // prIsFromFork reads the PR's repos, not the event, so this path is reached under every other
    // trigger too — where secrets ARE available. A hint that asserted the secrets cause would tell a
    // maintainer already on workflow_run to switch to workflow_run.
    const hint = forkNotice(PR).postFailureHint;
    assert.match(hint, /If this ran on a `pull_request` trigger/);
    // The second branch is the COMPLEMENT of the first, not an enumeration. resolveReviewTarget accepts
    // workflow_dispatch as well as workflow_run, so listing triggers left that operator reading two
    // branches both literally false about their own workflow — and would do so again for the next
    // trigger added. The fact that decides the remedy is whether secrets were available at all.
    assert.match(hint, /On any other trigger/);
    assert.match(hint, /workflow_dispatch/);
    assert.match(hint, /pull-requests: write/); // the other branch stays actionable
  });
});

describe('a notice that cannot be posted is as loud as the gap it was hiding', () => {
  const refusing = {
    rest: {
      pulls: {
        createReview: async () => { throw new Error('Resource not accessible by integration'); },
      },
    },
  };

  test('severity is carried by the notice, so the catch has nothing to branch on', () => {
    assert.equal(forkNotice(PR).reportPostFailure, core.warning);
    assert.equal(roundCapNotice(CAP_MESSAGE, null).reportPostFailure, core.setFailed);
  });

  test('the sink reports through the notice, carrying the cause AND that notice\'s own remedy', async () => {
    const said = [];
    const spy = { ...roundCapNotice(CAP_MESSAGE, null), reportPostFailure: m => said.push(m) };
    assert.equal(await announce(refusing, spy), 'failed');
    assert.equal(said.length, 1);
    assert.match(said[0], /The run did NOT review this pull request; nothing on the PR says so/);
    assert.match(said[0], /pull-requests: write/);
  });

  test('a refused round-cap notice REDS the run; a refused fork notice does not', async () => {
    // Setting process.exitCode is the whole point of core.setFailed, so it is saved and restored around
    // the assertion rather than left to fail this suite. Applying the fork's warn-only policy to a round
    // cap is what left a capped PR green with nothing posted on it — this mechanism's own failure mode.
    const before = process.exitCode;
    try {
      process.exitCode = 0;
      assert.equal(await announce(refusing, roundCapNotice(CAP_MESSAGE, null)), 'failed');
      assert.equal(process.exitCode, 1, 'a capped PR carrying no notice must not also be green');

      process.exitCode = 0;
      assert.equal(await announce(refusing, forkNotice(PR)), 'failed');
      assert.equal(process.exitCode, 0, 'a fork run can never be granted the token, so red would be forever');
    } finally {
      process.exitCode = before;
    }
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

// The two hosts' MEASURED dismissal contracts, as one table. Both rows were verified against live
// instances (github.com and Gitea v1.27.1) — see the transport constructors for the evidence. The fake
// below serves EXACTLY the row it is built for and 404s anything else, so a transport that sent GitHub's
// verb to Gitea fails here instead of at 3am on a deadlocked PR. A permissive fake accepting either route
// on either host would pass a swapped implementation, which is the one defect this seam exists to
// prevent. [LAW:behavior-not-structure] the contract asserted is "the block is released on this host",
// never "these functions were called".
const HOSTS = {
  github: {
    transport: () => gitHubTransport([], []),
    // A live GitHub review carries NO `dismissed` key at all, so the shape below is the real one — a fake
    // that helpfully added `dismissed: false` would hide a predicate that required the field.
    liveBlock: id => ({ id, state: 'CHANGES_REQUESTED' }),
    route: 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals',
    targetId: params => params.review_id,
    // GitHub REPLACES the state; the review is no longer CHANGES_REQUESTED afterwards.
    markDismissed: review => { review.state = 'DISMISSED'; },
    isLive: review => review.state === 'CHANGES_REQUESTED',
  },
  gitea: {
    transport: () => giteaTransport([], []),
    liveBlock: id => ({ id, state: 'REQUEST_CHANGES', dismissed: false }),
    route: 'POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/dismissals',
    targetId: params => params.id,
    // Gitea KEEPS state='REQUEST_CHANGES' and flips a flag — the case that makes a state-only predicate
    // re-dismiss the same review on every single push.
    markDismissed: review => { review.dismissed = true; },
    isLive: review => !review.dismissed,
  },
};

function fakeHost(kind) {
  const host = HOSTS[kind];
  const reviews = [];
  const calls = [];
  // Counted, not just captured: "the route was never resolved" is the perf contract, and only a count
  // can assert the absence of a call.
  let transportResolutions = 0;
  return {
    host,
    reviews,
    calls,
    get transportResolutions() { return transportResolutions; },
    resolveTransport: () => {
      transportResolutions += 1;
      return host.transport();
    },
    block(id) {
      const review = host.liveBlock(id);
      reviews.push(review);
      return review;
    },
    octokit: {
      request: async (route, params) => {
        // The single-review read is served at the SAME literal path by both hosts (verified live), which
        // is why the re-check needs no transport member. The fake serves it from the same store the
        // dismissal mutates, so "already dismissed" is a real round trip and not a stubbed answer.
        if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}') {
          const found = reviews.find(r => r.id === params.review_id);
          if (!found) throw new Error(`404 no review ${params.review_id}`);
          return { data: found };
        }
        if (route !== host.route) throw new Error(`404 Not Found: ${kind} does not serve "${route}"`);
        const target = reviews.find(r => r.id === host.targetId(params));
        if (!target) throw new Error(`404 no review ${JSON.stringify(host.targetId(params))} on this PR`);
        // Neither host makes dismissal idempotent — GitHub answers a second attempt with 422 "Can not
        // dismiss a dismissed pull request review" (measured). Modelling that is the whole point: a
        // permissive fake would let the release loop look correct while reddening real runs.
        if (!host.isLive(target)) throw new Error('422 Can not dismiss a dismissed pull request review');
        calls.push(params);
        host.markDismissed(target);
        return { data: target };
      },
    },
  };
}

const release = (pr, reviews, resolveTransport = pr.resolveTransport) =>
  releaseUnrevisitableBlocks(pr.octokit, resolveTransport, {
    owner: 'o', repo: 'r', pullNumber: PR, reviews, capMessage: CAP_MESSAGE,
  });

describe('a block the reviewer will not revisit is released', () => {
  for (const kind of Object.keys(HOSTS)) {
    describe(kind, () => {
      // The deadlock in one test: the round cap says "never again" while a REQUEST_CHANGES still gates
      // the merge, so an author who fixed every finding cannot merge and no re-review can ever clear it.
      test('the action dismisses its OWN outstanding block', async () => {
        const pr = fakeHost(kind);
        const blocked = pr.block(101);
        assert.equal(await release(pr, pr.reviews), 'released');
        assert.equal(pr.calls.length, 1);
        assert.equal(pr.host.targetId(pr.calls[0]), 101);
        assert.equal(isOutstandingBlock(blocked), false, 'the PR is no longer blocked');
      });

      // A PR that drew findings on more than one round before hitting the cap carries SEVERAL reviews
      // that all still block: neither host retroactively rewrites an earlier round's state when a later
      // round posts. Releasing only one of them would leave the PR just as deadlocked.
      test('every outstanding block is released, not just the newest', async () => {
        const pr = fakeHost(kind);
        const blocked = [pr.block(101), pr.block(102), pr.block(103)];
        assert.equal(await release(pr, pr.reviews), 'released');
        assert.deepEqual(pr.calls.map(c => pr.host.targetId(c)), [101, 102, 103]);
        assert.deepEqual(blocked.filter(isOutstandingBlock), [], 'no block left holding the merge');
      });

      // The partial path is where a `return` in the catch instead of a `push` would hide: the first
      // review would silently stay blocked while the run reported one tidy failure.
      test('one refused dismissal does not abandon the others, and only it is named', async () => {
        const pr = fakeHost(kind);
        const first = pr.block(101);
        const second = pr.block(102);
        const realRequest = pr.octokit.request;
        pr.octokit.request = async (route, params) => {
          if (pr.host.targetId(params) === 102) throw new Error('403 Forbidden');
          return realRequest(route, params);
        };
        const said = [];
        const realSetFailed = core.setFailed;
        const before = process.exitCode;
        try {
          process.exitCode = 0;
          core.setFailed = m => said.push(m);
          assert.equal(await release(pr, pr.reviews), 'failed');
        } finally {
          core.setFailed = realSetFailed;
          process.exitCode = before;
        }
        assert.equal(isOutstandingBlock(first), false, 'the reachable block was still released');
        assert.equal(isOutstandingBlock(second), true, 'the refused one is honestly still blocking');
        assert.equal(said.length, 1);
        assert.match(said[0], /102/);
        assert.equal(/\b101\b/.test(said[0]), false, 'the released review is not reported as a failure');
      });

      // Without this the reviewer would post a fresh dismissal on every push for the rest of the PR's
      // life. It falls out of the predicate rather than a flag: a released review is not outstanding.
      test('a second capped push releases nothing — the release is idempotent', async () => {
        const pr = fakeHost(kind);
        pr.block(101);
        await release(pr, pr.reviews);
        assert.equal(await release(pr, pr.reviews), 'nothing-to-release');
        assert.equal(pr.calls.length, 1);
      });

      // The route is never even resolved here. That is the perf contract, not an incidental detail: this
      // is the shape of every capped push for the rest of the PR's life, and resolving a transport would
      // re-list every changed file (and on Gitea re-fetch the whole unified diff) each time.
      test('a PR with no outstanding block is untouched, and no route is resolved', async () => {
        const pr = fakeHost(kind);
        pr.reviews.push({ id: 7, state: 'COMMENTED', dismissed: false });
        assert.equal(await release(pr, pr.reviews), 'nothing-to-release');
        assert.equal(pr.calls.length, 0);
        assert.equal(pr.transportResolutions, 0, 'no diff fetch on the common capped push');
      });

      test('the route IS resolved once when there is something to release', async () => {
        const pr = fakeHost(kind);
        pr.block(101);
        pr.block(102);
        assert.equal(await release(pr, pr.reviews), 'released');
        assert.equal(pr.transportResolutions, 1, 'resolved once for the whole release, not per review');
      });

      // Dismissal is not idempotent at either host, so a review someone else released between the
      // snapshot and the call answers with a hard error. The goal is a STATE though, and that state is
      // satisfied — reporting it as failure would red a build over a PR that is not blocked at all.
      test('a block someone else already released is not reported as a failure', async () => {
        const pr = fakeHost(kind);
        const review = pr.block(101);
        pr.host.markDismissed(review); // a human, or a racing run, got there first
        const said = [];
        const realSetFailed = core.setFailed;
        const before = process.exitCode;
        try {
          process.exitCode = 0;
          core.setFailed = m => said.push(m);
          // The snapshot still remembers it as outstanding, exactly as summarizePriorReviews would.
          assert.equal(await release(pr, [{ ...review, ...pr.host.liveBlock(101) }]), 'released');
          assert.equal(process.exitCode, 0, 'a PR that is not blocked must not red the run');
        } finally {
          core.setFailed = realSetFailed;
          process.exitCode = before;
        }
        assert.deepEqual(said, []);
      });

      // The mirror of the test above, and the branch where the state read actually decides: the refusal
      // is a permissions error, NOT "already released", so the re-check must find the block still live
      // and red. Only the dismissal route throws — the GET is served normally — so the verdict comes
      // from isOutstandingBlock on a real response rather than from the unreachable-host fallback.
      test('a refusal that is NOT a release still reds, decided by re-reading the state', async () => {
        const pr = fakeHost(kind);
        const review = pr.block(101);
        const realRequest = pr.octokit.request;
        pr.octokit.request = async (route, params) => {
          if (route === pr.host.route) throw new Error('403 Forbidden');
          return realRequest(route, params);
        };
        const said = [];
        const realSetFailed = core.setFailed;
        try {
          core.setFailed = m => said.push(m);
          assert.equal(await release(pr, pr.reviews), 'failed');
        } finally {
          core.setFailed = realSetFailed;
        }
        assert.equal(isOutstandingBlock(review), true, 'the block really is still holding');
        assert.equal(said.length, 1);
        assert.match(said[0], /101/);
        assert.match(said[0], /STILL holding the merge/);
      });

      // Failing to work out HOW to dismiss is a failure to enforce the invariant, not a harmless miss:
      // the PR may be deadlocked while every other signal says the cap was handled.
      test('a thunk that throws REDS the run and says the PR is still blocked', async () => {
        const pr = fakeHost(kind);
        pr.block(101);
        const said = [];
        const realSetFailed = core.setFailed;
        try {
          core.setFailed = m => said.push(m);
          const boom = () => { throw new Error('listFiles exploded'); };
          assert.equal(await release(pr, pr.reviews, boom), 'failed');
        } finally {
          core.setFailed = realSetFailed;
        }
        assert.equal(pr.calls.length, 0);
        assert.match(said[0], /listFiles exploded/);
        assert.match(said[0], /left blocked by review\(s\) this action has declined to revisit/);
        // The operator is told WHICH review to go dismiss by hand — the same specificity the
        // refused-dismissal path gives, on the path that never got as far as naming one.
        assert.match(said[0], /\b101\b/);
      });

      test('the dismissal says the findings were NOT re-checked', async () => {
        const pr = fakeHost(kind);
        pr.block(101);
        await release(pr, pr.reviews);
        const { message } = pr.calls[0];
        // A dismissal that just vanished would read as "the reviewer looked again and is satisfied".
        assert.match(message, /NOT re-checked and are NOT confirmed fixed/);
        assert.match(message, /removes only the merge block/);
        // The remedy is single-sourced with the notice, so the PR cannot state two different ones.
        assert.ok(message.includes(CAP_MESSAGE), 'carries the same cap sentence the notice carries');
      });

      // A dismissal the host refused leaves the PR exactly as deadlocked, while every other signal says
      // the cap was handled — green-and-stuck is the state this whole mechanism exists to abolish.
      test('a refused dismissal REDS the run and says the PR is still blocked', async () => {
        const pr = fakeHost(kind);
        pr.block(101);
        pr.octokit.request = async () => { throw new Error('403 Forbidden'); };
        const before = process.exitCode;
        try {
          process.exitCode = 0;
          assert.equal(await release(pr, pr.reviews), 'failed');
          assert.equal(process.exitCode, 1, 'a still-deadlocked PR must not also be green');
        } finally {
          process.exitCode = before;
        }
      });
    });
  }

  // Three spellings for one concept: the event SUBMITTED is REQUEST_CHANGES on both hosts, but the state
  // READ BACK differs, and Gitea's dismissed review keeps the live spelling. Reading GitHub's word on
  // Gitea never releases anything; reading Gitea's word on GitHub re-dismisses forever.
  test('one predicate accepts each host live block and rejects each host released shape', () => {
    // GitHub: no `dismissed` key exists at all, and a released review changes STATE.
    assert.equal(isOutstandingBlock({ state: 'CHANGES_REQUESTED' }), true);
    assert.equal(isOutstandingBlock({ state: 'DISMISSED' }), false);
    // Gitea: the state is UNCHANGED by dismissal, so only the flag separates live from released. This
    // pair is the whole reason the predicate cannot read state alone.
    assert.equal(isOutstandingBlock({ state: 'REQUEST_CHANGES', dismissed: false }), true);
    assert.equal(isOutstandingBlock({ state: 'REQUEST_CHANGES', dismissed: true }), false);
    // Neither host's non-blocking verdicts are ever mistaken for a block.
    for (const state of ['APPROVED', 'COMMENTED', 'PENDING']) {
      assert.equal(isOutstandingBlock({ state }), false, state);
    }
  });

  // A host that reports no dismissal state at all cannot be served idempotently — dismissal is not a
  // no-op on either host — so the choice is between reddening every push and silently never releasing.
  // Absence-as-live is the loud direction, pinned here rather than left to Boolean(undefined) by accident.
  test('a review reporting no dismissal state at all is treated as live, not as released', () => {
    assert.equal(isOutstandingBlock({ state: 'REQUEST_CHANGES' }), true);
    // The alternative reading would leave a real block unreleased with nothing said — the exact
    // deadlock this feature exists to abolish, reached silently.
    assert.equal(isOutstandingBlock({ state: 'REQUEST_CHANGES', dismissed: undefined }), true);
  });

  // Gitea dismisses `priors: false` — `true` would sweep every earlier review on the PR, including a
  // human's. The action releases only the block it is itself holding.
  test('the Gitea dismissal never sweeps prior reviews', async () => {
    const pr = fakeHost('gitea');
    pr.block(101);
    await release(pr, pr.reviews);
    assert.equal(pr.calls[0].priors, false);
  });
});
