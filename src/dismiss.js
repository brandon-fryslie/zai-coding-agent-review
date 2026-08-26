'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const {
  resolveReviewTarget, summarizePriorReviews, hasDeclinedRevisit, selectTransport, resolveReviewerIdentities,
  releaseUnrevisitableBlocks, parseReviewerName, prIsFromFork, NOT_REVIEWED_REASONS,
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

  // [LAW:one-source-of-truth] The SAME fork gate `run.js` runs, checked BEFORE anything here reads
  // DISMISS_TOKEN — this action shares `run.js`'s documented wiring (`if: always()`, immediately after
  // the review step, on the same `pull_request` trigger), and `transport.js`'s `forkNotice` comment
  // states the fact plainly: a fork PR receives no repository secrets at all, so DISMISS_TOKEN resolves
  // to '' there just like GITHUB_REVIEW_TOKEN does. That is the expected, unfixable no-secrets case for a
  // fork PR — not a misconfiguration — so it must never reach the "DISMISS_TOKEN is required" failure
  // below. This action posts nothing of its own on a fork PR (the review step's own fork notice already
  // covers it), so a clean, silent no-op is all this needs — the same standing `run.js` gives an
  // ordinary "nothing outstanding" push. [LAW:no-silent-failure] the reason is still named, on info, so an
  // operator reading the run log sees why nothing happened rather than being left to guess.
  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }));
  } catch (e) {
    core.setFailed(`Failed to fetch PR #${pullNumber}: ${e.message}`);
    return;
  }
  let isFork;
  try {
    isFork = prIsFromFork(pr);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  if (isFork) {
    core.info(
      `PR #${pullNumber} is from a fork. Fork pull requests receive no repository secrets, so `
      + 'DISMISS_TOKEN is expected to be unset here — this is not a misconfiguration. Nothing to '
      + "release: this action never runs the review this PR's block (if any) would need superseding.",
    );
    return;
  }

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

  const reviewOctokit = github.getOctokit(reviewToken || token);
  const dismissOctokit = github.getOctokit(dismissToken);
  const reviewerName = parseReviewerName(core.getInput('ZAI_REVIEWER_NAME'));

  // [LAW:no-silent-failure] home-copirate-review-itv-4-2 (round 4): `hasDeclinedRevisit` used to trust
  // `prior.latestArtifact` from body content alone — the round-cap marker is a public, literal string, so
  // any account with read access could post a review ending in it and have this run treat that as the
  // review action's own decision to give up, releasing every genuinely outstanding block with the Admin
  // credential below. The fix is to ask who THIS run itself would trust to have posted that notice, and
  // require the artifact's actual author to match: `reviewOctokit` is built from the same credential
  // (`GITHUB_REVIEW_TOKEN`, or its `GITHUB_TOKEN` fallback) that `run.js` posts round-cap notices under, so
  // resolving ITS identity answers who a genuine notice was posted as — without hardcoding a bot username,
  // which would break the documented user-PAT `GITHUB_REVIEW_TOKEN` path this repo already supports.
  //
  // The ids that comparison needs exist only on the login arm, taken from the `/user` payload the login
  // itself came from. On the installation arm there is no successful `/user` at all — the identity is
  // confirmed structurally and carries `id: null`, so `hasDeclinedRevisit` finds nothing to match and this
  // run releases nothing. That is the same safe direction as a failed resolution, reached by a different
  // road, and it is why the null is a carried VALUE rather than something to paper over here.
  //
  // A failure here is NOT a reason to fall back to trusting body content — it is treated as "cannot verify",
  // and this run releases nothing. The safe direction is a block that stays up one run longer, not one a
  // forgery could talk this run into dropping.
  //
  // [LAW:one-source-of-truth] ONE resolution answers both questions this action asks about identity: which
  // reviews on the PR are the review action's own (`summarizePriorReviews`' author gate) and which id a
  // genuine round-cap notice was posted under (`hasDeclinedRevisit`). This used to be two independent
  // `GET /user` calls on the same credential, which is two clocks: they can disagree — one 503s, or a
  // rotation lands between them — and nothing would say which answer was right.
  //
  // [LAW:no-silent-failure] Unlike `run.js`, an unresolvable identity here is a WARNING and an early
  // return, not a red run. The difference is what each action loses: `run.js` cannot enforce a round cap
  // without knowing its own rounds, so guessing there uncaps spend. This action's whole job is optional
  // cleanup on an `if: always()` step, so "do nothing this push" is a complete, correct outcome — and
  // reddening every Gitea push over a transient identity hiccup would be noise reported as a defect.
  // [LAW:one-source-of-truth] The set covers EVERY credential that can have posted an artifact on this
  // PR, exactly as `run.js` does — not just the one posting now. Resolving `reviewOctokit` alone looks
  // sufficient and is the bug this action exists to prevent, one level down: add `GITHUB_REVIEW_TOKEN`
  // to a repo with a live PR (the transition the README recommends) and every round, block and notice
  // posted earlier under the default `GITHUB_TOKEN` fails the author gate, drops out of `prior.reviews`,
  // and leaves `releasable` empty. The round-cap notice still verifies, so this action would report
  // "nothing outstanding" and walk away from precisely the deadlock it was written to clear.
  //
  // The same set answers BOTH questions this action asks — which reviews are ours, and whether the
  // round-cap notice is ours — so there is no second, narrower notion of "trusted" to drift from the
  // first. An earlier revision passed only the posting credential's id to `hasDeclinedRevisit`, which
  // reintroduced the deadlock for a notice posted BEFORE `GITHUB_REVIEW_TOKEN` was added.
  const distinctTokens = [...new Set([reviewToken || token, token])];
  let identities;
  try {
    identities = await resolveReviewerIdentities(
      [reviewOctokit, ...distinctTokens.slice(1).map(t => github.getOctokit(t))],
    );
  } catch (e) {
    core.warning(
      `Could not verify the review action's own identity via GITHUB_REVIEW_TOKEN (or its GITHUB_TOKEN `
      + `fallback): ${e.message}. Treating PR #${pullNumber}'s round-cap notice, if any, as unverifiable — `
      + 'no block will be released this run.',
    );
    return;
  }

  let prior;
  try {
    prior = await summarizePriorReviews(octokit, owner, repo, pullNumber, identities);
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
  // round-cap notice standing as the newest agent artifact AND carrying the identity this run trusts.
  // [LAW:one-source-of-truth] one decision, made once by the review run, recorded once on the PR, read
  // here rather than recomputed.
  const declinedRevisit = hasDeclinedRevisit(prior.latestArtifact, identities);
  const releasable = declinedRevisit ? prior.reviews : [];

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
  // the reviewer still intends to revisit — so it names which of the three quiet reasons it was, rather
  // than leaving an operator to guess whether this action ran at all. Failures are reported by the release
  // itself. The three are distinguished in the same order `hasDeclinedRevisit` checks them: a notice that
  // isn't a round-cap one at all, a genuine round-cap notice this run could not attribute to a trusted
  // identity (no resolved identity carried an id, or the notice's `postedBy` was absent or matched none), and nothing
  // outstanding to release even though the notice checked out.
  if (outcome === 'nothing-to-release') {
    let reason;
    if (!declinedRevisit) {
      const looksLikeRoundCap = prior.latestArtifact?.kind === 'not-reviewed'
        && prior.latestArtifact?.reason === NOT_REVIEWED_REASONS.ROUND_CAP;
      reason = looksLikeRoundCap
        ? "This pull request carries a round-cap notice, but this run could not attribute it to a trusted identity (see the warning above, if any) — treating it as unverified rather than releasing on body content alone."
        : "The review action has not declined to revisit this pull request — its newest notice is not a round-cap one — so any blocking review it holds is one it still intends to supersede.";
    } else {
      reason = "This action's own reviews carry no outstanding block.";
    }
    core.info(`PR #${pullNumber}: nothing released. ${reason}`);
  }
}

module.exports = { run };
