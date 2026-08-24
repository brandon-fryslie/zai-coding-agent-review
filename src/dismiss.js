'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const {
  resolveReviewTarget, summarizePriorReviews, isOutstandingBlock, selectTransport,
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

  const outstanding = prior.reviews.filter(isOutstandingBlock);
  if (outstanding.length === 0) {
    core.info(`PR #${pullNumber} has no outstanding block from this action's own reviews; nothing to release.`);
    return;
  }

  // This run does not know WHY the review action stopped revisiting the PR (the round-cap sentence lives
  // in that run's own notice, already posted) — it only knows a block is still outstanding after that
  // decision. Naming the notice rather than repeating an unverifiable reason keeps this message honest:
  // it can point at where the explanation lives without asserting it here a second time. [LAW:no-silent-failure]
  const capMessage = "the review action's own notice on this pull request explains why it will not "
    + 'revisit this review; this run only releases the merge block it left behind.';
  await releaseUnrevisitableBlocks(reviewOctokit, () => selectTransport(octokit, owner, repo, pullNumber), {
    owner, repo, pullNumber, reviews: prior.reviews, capMessage,
    commitId: headSha, reviewerName, releaseFailureBodies: prior.releaseFailureBodies,
    dismissOctokit,
  });
}

module.exports = { run };
