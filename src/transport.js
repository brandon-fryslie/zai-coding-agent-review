'use strict';
const core = require('@actions/core');
const { parseUnifiedDiff } = require('./diff');
const { severityTaggedBody } = require('./review');
const { parseCostMarker } = require('./usage');

const REVIEW_MARKER = '<!-- copirate-code-review-agent -->';
const APPROVED_MESSAGE = '✅ Approved';
const REQUEST_CHANGES_MESSAGE = '❌ Request Changes';

async function listAllFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return files;
}

// [LAW:one-type-per-behavior] One transport; the host differs only in how the diff is
// sourced, how a finding's new-file line becomes a review comment, and which literal
// string its review-submission API expects for an approval event (approveEvent below).
// [LAW:dataflow-not-control-flow] Capability — does listFiles carry per-file patch? —
// selects the instance, not a hardcoded hostname (GitHub & Enterprise carry it; Gitea does not).
//
// [LAW:no-silent-failure] approveEvent exists because GitHub and Gitea disagree on this one
// verb: GitHub's create-review `event` takes the imperative 'APPROVE', but Gitea's is typed as
// `ReviewStateType`, whose approved value is the past-tense 'APPROVED' (REQUEST_CHANGES and
// COMMENT happen to share GitHub's spelling). Gitea's handler has no else-error branch for an
// unrecognized event string — it falls through to ReviewTypePending — so sending 'APPROVE' to
// Gitea produced a 200 response with the review silently stuck at state=PENDING forever, with
// no error anywhere in the chain (verified against Gitea v1.27.1 source and reproduced live:
// home-copirate-review-9uj.12).
function gitHubTransport(files) {
  return { files, toComment: f => ({ path: f.path, line: f.line, side: 'RIGHT', body: f.body }), approveEvent: 'APPROVE' };
}

function giteaTransport(files) {
  return { files, toComment: f => ({ path: f.path, new_position: f.line, body: f.body }), approveEvent: 'APPROVED' };
}

async function selectTransport(octokit, owner, repo, pullNumber) {
  const files = await listAllFiles(octokit, owner, repo, pullNumber);
  if (files.length === 0 || files.some(f => typeof f.patch === 'string')) {
    return gitHubTransport(files);
  }
  // [LAW:no-silent-failure] Gitea omits per-file patch; its unified .diff carries the hunks.
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}.diff', {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const { files: parsed, warnings } = parseUnifiedDiff(typeof data === 'string' ? data : String(data));
  warnings.forEach(w => core.warning(w));
  if (parsed.length === 0) {
    throw new Error(`No reviewable diff for PR #${pullNumber}: listFiles returned no patch and the unified diff was empty.`);
  }
  return giteaTransport(parsed);
}

// [LAW:one-source-of-truth] A completed review round IS a posted review carrying REVIEW_MARKER, and its
// cost IS the cost marker in that same body — there is no separate counter or ledger to drift. One pass
// over the PR's own reviews yields BOTH the round count (for the round cap) and the summed cost (for the
// PR-total footer), so the two consumers share one fetch. [LAW:decomposition] "summarize this PR's prior
// agent reviews" is one cohesive concern. The listReviews API is served by GitHub and Gitea alike and
// both markers live in the body regardless of host, so this is host-agnostic. [LAW:no-silent-failure]
// pagination is exhausted so a PR with many reviews is summarized in full, never truncated.
async function summarizePriorReviews(octokit, owner, repo, pullNumber) {
  let count = 0;
  let usd = 0;
  let knownRounds = 0;
  let unknownRounds = 0;
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    for (const r of data) {
      const body = typeof r.body === 'string' ? r.body : '';
      // [LAW:single-enforcer] ONE definition of "an agent review round" — a body whose trailing
      // sentinel is REVIEW_MARKER — gates BOTH the count and the cost sum. Matching the ending (not a
      // loose `includes`) means a human review that merely quotes a marker satisfies neither, so it can
      // over-count neither rounds nor cost. Cost is read only from within that gate.
      if (!body.trimEnd().endsWith(REVIEW_MARKER)) continue;
      count++;
      // [LAW:no-silent-failure] An agent round with a numeric cost marker is summed; any other case —
      // an explicit 'unknown' marker, a pre-feature review with no marker, or a malformed value that
      // won't parse — is a round whose cost we don't have, counted as unknown so the PR total is an
      // honest lower bound (+), never silently omitted.
      const cost = parseCostMarker(body);
      if (typeof cost === 'number') { usd += cost; knownRounds++; }
      else unknownRounds++;
    }
    if (data.length < 100) break;
    page++;
  }
  return { count, cost: { usd, knownRounds, unknownRounds } };
}

// [LAW:effects-at-boundaries] Pure, split from the fetch below so it is testable without a fake API:
// pair each earlier RA finding with the author's (OA's) reply to it. The review-comment thread already
// encodes the roles STRUCTURALLY — RA posts each finding as a top-level inline review comment
// (`in_reply_to_id` absent) via createReview, and the address-pr-reviews loop posts the author's
// pushback as a REPLY to that thread (`in_reply_to_id` set) — so no author-identity lookup or
// keyword heuristic is needed to tell a finding from a response. [LAW:types-are-the-program]
//
// [LAW:no-silent-failure] Only a finding that RECEIVED a reply is returned: a finding with no reply is
// one the author silently applied or ignored — there is no rebuttal to learn from, and the fresh diff
// already reflects any fix, so replaying it would be noise. This naturally spans rounds and needs no
// round bookkeeping: a still-unanswered finding from THIS round (no reply yet) is simply excluded, and
// any answered finding from ANY earlier round is included. [LAW:dataflow-not-control-flow] the "which
// findings" is decided by the data (has a reply?), never by a round counter.
function pairPushbacks(comments) {
  const repliesByParent = new Map();
  for (const c of comments) {
    if (c.in_reply_to_id == null) continue;
    const list = repliesByParent.get(c.in_reply_to_id) || [];
    list.push((c.body || '').trim());
    repliesByParent.set(c.in_reply_to_id, list);
  }
  const pushbacks = [];
  for (const c of comments) {
    if (c.in_reply_to_id != null) continue; // a reply, not a finding
    const replies = (repliesByParent.get(c.id) || []).filter(Boolean);
    if (replies.length === 0) continue; // no author response ⇒ nothing to weigh
    // line is display-only context (not an anchor), so a host that omits it (Gitea) degrades to
    // path-only rather than failing — the reviewer still locates the finding by path + body.
    pushbacks.push({ path: c.path, line: c.line ?? c.original_line ?? null, finding: (c.body || '').trim(), replies });
  }
  return pushbacks;
}

// [LAW:effects-at-boundaries] The one I/O edge: exhaust the PR's inline review-comment pages, then hand
// the raw comments to the pure pairing above. listReviewComments is served by GitHub and Gitea alike
// and both carry in_reply_to_id, so this is host-agnostic like summarizePriorReviews. [LAW:decomposition]
// This is a SEPARATE concern from summarizePriorReviews (which reads review BODIES for round-count + cost)
// — a different endpoint (inline COMMENTS) and a different product (finding↔reply pairs) — so it is its
// own function, not an "and" bolted onto that one.
async function fetchPriorPushbacks(octokit, owner, repo, pullNumber) {
  const comments = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    comments.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return pairPushbacks(comments);
}

// [LAW:effects-at-boundaries] Pure decision, split from the I/O above so it is testable without a
// fake API. [LAW:dataflow-not-control-flow] The cap is a value, not a mode: maxRounds <= 0 is the
// documented "unlimited" sentinel (matching MAX_DIFF_CHARS), so there is no separate enable flag.
// Skip once priorReviews has reached the cap — with maxRounds=5, rounds recorded at priorReviews
// 0..4 run and the 6th push (priorReviews=5) is skipped, yielding exactly 5 reviews.
function roundCapReached(priorReviews, maxRounds) {
  return maxRounds > 0 && priorReviews >= maxRounds;
}

// [LAW:no-silent-failure] Parse the round cap strictly. The prior `parseInt(raw, 10) || 0` silently
// turned any non-numeric input (a typo like "five") into 0 = unlimited — DISABLING the cost cap on a
// misconfiguration, the exact opposite of intent, with no diagnostic. And `parseInt("3x", 10)` → 3
// caps at a value the user never wrote. [LAW:types-are-the-program] the input's domain is a
// non-negative integer (0 = unlimited); accept a run of digits, reject everything else loudly. Empty
// (an explicitly cleared input) is unlimited; unset gets action.yml's "5" default from the runner.
function parseMaxRounds(raw) {
  const s = String(raw).trim();
  if (s === '') return 0;
  if (!/^\d+$/.test(s)) {
    throw new Error(`MAX_REVIEW_ROUNDS must be a non-negative integer (0 = unlimited); got "${raw}".`);
  }
  return parseInt(s, 10);
}

// [LAW:dataflow-not-control-flow] A review is ALWAYS posted to the PR. The data
// (findings present? token approval-capable?) selects only the event string —
// never whether the message is posted. canApprove gates approval vs COMMENT
// because the default GITHUB_TOKEN cannot submit a formal approval, but a
// visible "✅ Approved" message must still land on the PR either way.
// [LAW:one-source-of-truth] The approval verb's spelling is owned by the transport
// (transport.approveEvent), not restated here — REQUEST_CHANGES and COMMENT are
// spelled identically by every host this action targets, so only the approve
// branch varies per transport.
function reviewEvent(requestsChanges, canApprove, transport) {
  return requestsChanges ? 'REQUEST_CHANGES' : (canApprove ? transport.approveEvent : 'COMMENT');
}

// [LAW:effects-at-boundaries] Pure: render the findings that could not be posted inline as a
// summary section. They still carry their path:line so the reader can locate them.
function renderUnanchoredSection(unanchored) {
  if (!unanchored || unanchored.length === 0) return '';
  const items = unanchored
    .map(f => `- \`${f.path}:${f.line}\` — ${severityTaggedBody(f)}`)
    .join('\n');
  return `\n\n### Findings outside the reviewed diff\nThese reference lines not present in this PR's diff, so they could not be posted as inline comments:\n\n${items}`;
}

async function submitReview(octokit, owner, repo, pullNumber, commitId, reviewerName, review, canApprove, transport, attributionFooter) {
  // [LAW:one-source-of-truth] One boolean drives both the GitHub event and the rendered
  // verdict, so they cannot disagree. The model never states the verdict.
  // [LAW:dataflow-not-control-flow] The verdict is derived from a value carried on each finding —
  // its severity — not from whether the finding exists. Only BLOCKING findings force
  // REQUEST_CHANGES; a review of purely advisory findings is APPROVE/COMMENT. An unanchored
  // blocking finding still counts, so a mis-anchored real blocker can never silently downgrade the
  // verdict to APPROVE. [LAW:no-silent-failure] Advisory findings are never dropped — they still
  // post inline (below) and render in the unanchored section, just tagged and non-blocking.
  const unanchored = review.unanchored || [];
  const isBlocking = f => f.severity === 'blocking';
  const requestsChanges = review.findings.some(isBlocking) || unanchored.some(isBlocking);
  const event = reviewEvent(requestsChanges, canApprove, transport);
  const verdict = requestsChanges ? REQUEST_CHANGES_MESSAGE : APPROVED_MESSAGE;
  const footer = attributionFooter ? `\n\n${attributionFooter}` : '';
  // [LAW:dataflow-not-control-flow] The dependency section is a VALUE prepended to the summary: a
  // dependency-bump PR leads with its scannable roll-up + per-module breakdown; every other PR carries
  // '' and the body is byte-identical to before. The section is assembled host-side in run.js (from the
  // structured summaries + the model's assessments); this sink only places it. [LAW:single-enforcer]
  const dependencySection = review.dependencySection ? `${review.dependencySection}\n\n` : '';
  const body = `## ${reviewerName}\n\n${dependencySection}${review.summary}${renderUnanchoredSection(unanchored)}\n\n${verdict}${footer}\n\n${REVIEW_MARKER}`;
  const comments = review.findings.map(finding => transport.toComment({ ...finding, body: severityTaggedBody(finding) }));

  // [LAW:single-enforcer] The action owns GitHub review transport; Claude owns only typed review judgment.
  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitId,
    event,
    body,
    ...(comments.length > 0 ? { comments } : {}),
  });
  core.info(verdict);
}

// [LAW:single-enforcer] One resolver decides which pull request to review, from
// whichever provenance the triggering event offers. pull_request / pull_request_target
// carry the PR in the event payload; other events (workflow_run, workflow_dispatch)
// carry no PR, so the caller passes PR_NUMBER / HEAD_SHA explicitly. Explicit inputs win
// when present; the event payload is the zero-config default. Neither present is a loud
// failure upstream, never a silent skip. [LAW:no-silent-failure]
function resolveReviewTarget(numberInput, headShaInput, payload) {
  const pr = payload.pull_request;
  return {
    pullNumber: numberInput ? Number(numberInput) : pr?.number,
    headSha: headShaInput || pr?.head?.sha,
  };
}

// [LAW:effects-at-boundaries] Pure: a PR is from a fork when its head repository is not
// the base repository, compared by stable numeric repo id (rename-safe).
//
// The two absent-repo cases are NOT the same and must not be folded together:
//   - head.repo == null is a real domain state — the source fork was deleted — and the
//     only correct answer is "fork": there is no trusted same-repo source to review.
//     [LAW:no-defensive-null-guards] a real optional value with a meaningful outcome.
//   - base.repo absent is impossible for a well-formed PR (every PR has a base repository).
//     Treating it as "fork" would silently turn malformed data into a skipped review, so we
//     reject it loudly instead and let the boundary report it. [LAW:no-silent-failure]
function prIsFromFork(pr) {
  const baseRepo = pr.base?.repo;
  if (!baseRepo) {
    throw new Error('PR data has no base repository; cannot determine fork status.');
  }
  const headRepo = pr.head?.repo;
  if (!headRepo) return true;
  return headRepo.id !== baseRepo.id;
}

module.exports = {
  gitHubTransport,
  giteaTransport,
  selectTransport,
  submitReview,
  resolveReviewTarget,
  prIsFromFork,
  summarizePriorReviews,
  fetchPriorPushbacks,
  pairPushbacks,
  roundCapReached,
  parseMaxRounds,
  REVIEW_MARKER,
};
