'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const {
  resolveReviewTarget, summarizePriorReviews, hasDeclinedRevisit, selectTransport,
  releaseUnrevisitableBlocks, parseReviewerName,
} = require('./transport');

// itv.4.1: the SECOND, small action this repo ships, specifically so a Gitea-only credential never
// becomes an input on the review action every GitHub consumer shares (see CLAUDE.md's "Host transport"
// section for why that action never grows a DISMISS_TOKEN input of its own). This run does one thing:
// read whatever the review action already left on this PR — a round-cap-blocked review it either
// declined or was refused (write access) to dismiss — and release it with a separate, Admin-level
// credential Gitea's dismiss-review endpoint requires (MEASURED live against Gitea 1.27.1: the access
// that is enough to POST a review is not enough to DISMISS one). It reviews nothing, spawns no engine,
// and posts no verdict of its own; a PR with nothing outstanding is a silent no-op. [LAW:single-enforcer]
async function run() {
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);
  const reviewToken = core.getInput('GITHUB_REVIEW_TOKEN');
  if (reviewToken) core.setSecret(reviewToken);
  const dismissToken = core.getInput('DISMISS_TOKEN');
  if (!dismissToken) {
    core.setFailed(
      'DISMISS_TOKEN is required — this action exists to dismiss with a credential the review action '
      + 'does not carry (Gitea requires repo-Admin to dismiss a review; GITHUB_REVIEW_TOKEN is deliberately '
      + 'kept at write). Pass a token for a separate Admin-level account.',
    );
    return;
  }
  core.setSecret(dismissToken);

  const { context } = github;
  const { owner, repo } = context.repo;
  const { pullNumber, headSha } = resolveReviewTarget(
    core.getInput('PR_NUMBER'),
    core.getInput('HEAD_SHA'),
    context.payload,
  );
  if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !headSha) {
    core.setFailed(
      'Could not determine which pull request to release a block on. On pull_request events this is '
      + 'detected automatically; pass PR_NUMBER and HEAD_SHA explicitly on others (e.g. workflow_run).',
    );
    return;
  }

  // [LAW:one-source-of-truth] The SAME read-level token the review action itself uses to fetch a PR's
  // prior reviews — this action never needs write access of its own beyond the one dismissal call, and
  // GITHUB_REVIEW_TOKEN (when supplied) is reserved for posting a failure notice under the review
  // action's own identity, matching how a human reading the PR already expects that voice to speak.
  const octokit = github.getOctokit(token);
  const reviewOctokit = github.getOctokit(reviewToken || token);
  const dismissOctokit = github.getOctokit(dismissToken);
  const reviewerName = parseReviewerName(core.getInput('ZAI_REVIEWER_NAME'));

  let prior;
  try {
    prior = await summarizePriorReviews(octokit, owner, repo, pullNumber);
  } catch (e) {
    core.setFailed(`Failed to read PR #${pullNumber}'s prior reviews: ${e.message}`);
    return;
  }

  // [LAW:dataflow-not-control-flow] "Which of this action's blocks may this run release?" is a VALUE, and
  // the release below runs unconditionally against it — an empty list resolves no transport and dismisses
  // nothing (`releaseUnrevisitableBlocks` returns 'nothing-to-release' before touching the network).
  //
  // The value is gated, because a still-outstanding block is NOT by itself a block anyone has given up on.
  // `isOutstandingBlock` is equally true of a REQUEST_CHANGES the review action posted seconds ago for real,
  // unaddressed findings that it fully intends to re-examine on the next push — and this action's documented
  // wiring (`if: always()`, immediately after the review step) puts it in front of exactly that review on
  // every push. Releasing on outstanding-ness alone would therefore dismiss every fresh block a repo's
  // reviewer ever posts, defeating `block_merge_on_rejected_reviews` on precisely the pushes it exists for.
  //
  // `run.js` carries the missing fact in its position — it releases only from inside the round-cap branch.
  // This action is a separate process with no such position, so it reads the fact off the PR instead: the
  // round-cap notice standing as the newest agent artifact. [LAW:one-source-of-truth] one decision, made
  // once by the review run, recorded once on the PR, read here rather than recomputed.
  const releasable = hasDeclinedRevisit(prior.latestArtifact) ? prior.reviews : [];

  // [LAW:types-are-the-program] The gate above is what makes this sentence TRUE rather than merely hopeful.
  // It asserts an explanation is on the PR, and it is posted verbatim into the PR's permanent review
  // history — so it must not be reachable from the state where the round-cap notice failed to post and no
  // explanation exists. It isn't: that state leaves the notice off the PR, so it is not `latestArtifact`,
  // so `releasable` is empty and nothing is dismissed. Hedging the wording instead ("if a notice exists")
  // would have kept that state representable and pushed the question onto the reader.
  // This run still does not repeat WHY the review action stopped — that sentence lives in the notice, whose
  // presence is now established rather than assumed — it only names where to read it. [LAW:no-silent-failure]
  const capMessage = "the review action's own notice on this pull request explains why it will not "
    + 'revisit this review; this run only releases the merge block it left behind.';
  const outcome = await releaseUnrevisitableBlocks(reviewOctokit, () => selectTransport(octokit, owner, repo, pullNumber), {
    owner, repo, pullNumber, reviews: releasable, capMessage,
    commitId: headSha, reviewerName, releaseFailureBodies: prior.releaseFailureBodies,
    dismissOctokit,
  });
  // [LAW:no-silent-failure] The quiet path is the overwhelmingly common one — every push that drew findings
  // the reviewer still intends to revisit — so it says which of the two quiet reasons it was, rather than
  // leaving an operator to guess whether this action ran at all. Failures are reported by the release itself.
  if (outcome === 'nothing-to-release') {
    core.info(
      `PR #${pullNumber}: nothing released. ${releasable.length === 0
        ? "The review action has not declined to revisit this pull request — its newest notice is not a round-cap one — so any blocking review it holds is one it still intends to supersede."
        : "This action's own reviews carry no outstanding block."}`,
    );
  }
}

module.exports = { run };
