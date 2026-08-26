'use strict';
const { costMarker, parseCost, emptyTallies, tallyCost } = require('./usage');

// The append-only daily cost ledger: the persistent cross-run store of actual review spend, scoped to
// one repo-day, that the budget gradient (zai-budget-qzm) reads before deciding this review's effort.
//
// [LAW:one-source-of-truth] It mints NO new cost representation. A ledger entry IS the same
// machine-readable cost marker already embedded in every PR review body (usage.js: costMarker /
// parseCostMarker) — the ledger only widens that one representation from per-PR scope to repo-day
// scope. The day's spend is a SUM of immutable append-only records, never a mutable counter.
// [LAW:no-shared-mutable-globals] Append-only is race-free: each run posts one comment; the read sums
// the day's comments. There is no read-modify-write, so concurrent runs cannot clobber each other.
//
// [LAW:effects-at-boundaries] The store is a dedicated repo ISSUE; the two operations that touch it —
// readSpentToday (list + sum) and appendCost (post one entry) — are effects. The summing/filtering
// core (sumCostToday) is pure and testable without a fake API. Neither effect owns the "did this fail
// the run?" decision: on an API error they PROPAGATE (never swallow), so the run() boundary that wires
// them (zai-budget-qzm.5) owns warn-loud-and-continue for a failed append (the ledger then under-counts
// — an honest lower bound) and the spend-safe fallback for a failed read. [LAW:no-silent-failure]
//
// This module is handed its inputs as VALUES: the ledger issue number (discovered from a repo Actions
// variable at the run boundary) and the reference `now`. It reads neither env nor the clock, so the
// clock has a single explicit owner upstream. [LAW:no-ambient-temporal-coupling]

// [LAW:types-are-the-program] The entry sentinel: a machine-written ledger entry LEADS with this HTML
// comment (invisible in rendered markdown, like REVIEW_MARKER). It makes "is this comment a ledger
// entry" a checkable property, not a guess — the exact discipline summarizePriorReviews applies with
// its trailing REVIEW_MARKER gate. [LAW:no-silent-failure] Without it, a stray human comment on the
// ledger issue that merely QUOTED a cost marker would be summed — and the unsafe direction here is
// OVER-count (a phantom spend throttles effort down on bad data), so the gate matters.
const LEDGER_MARKER = '<!-- agent-review-cost-ledger-entry -->';

// [LAW:effects-at-boundaries] Pure: the body of one ledger entry — the sentinel then the reused cost
// marker. `usage` is the same value costMarker consumes at the review sink — the token record, the
// span, and the discriminated cost (see THE TOKEN RECORD and THE COST VALUE in src/usage.js) — so an
// unpriced cost writes a marker carrying no figure: the entry still exists (a review happened), its
// cost is simply counted as unknown on read, never fabricated as zero.
// The entry records the SAME facts the PR review's own marker does — tokens, model, provider, span —
// because the day's ledger is exactly as repriceable-after-the-fact as the review is, and writing a
// poorer record here would have made the ledger the one place a corrected price table could not
// reach. [LAW:one-source-of-truth] one marker writer, one record, two sinks.
// [LAW:dataflow-not-control-flow] The append is UNCONDITIONAL for every basis — a subscription review
// records an entry like any other, and its exclusion from the day's dollars is the marker NAME
// costMarker chose, never a caller that skips appendCost. A skipped append would make the
// subscription's consumption invisible instead of merely unbilled. [LAW:no-silent-failure]
function ledgerEntryBody(usage, config) {
  return `${LEDGER_MARKER}\n${costMarker(usage, config)}`;
}

// [LAW:effects-at-boundaries] Pure: the UTC calendar date ('YYYY-MM-DD') of an ISO timestamp or Date.
// UTC (not local) so the day boundary is deterministic and DST-free — the same instant yields the same
// day on every runner. [LAW:no-silent-failure] a malformed timestamp makes toISOString throw ("Invalid
// time value") rather than silently miscounting: the read reds loudly and the boundary takes its safe
// fallback, never a quiet wrong day.
function utcDay(dateish) {
  return new Date(dateish).toISOString().slice(0, 10);
}

// [LAW:effects-at-boundaries] Pure: tally the cost of the ledger entries dated today (UTC of `now`).
// [LAW:single-enforcer] ONE definition of "a today ledger entry" gates the tally: a comment that LEADS
// with LEDGER_MARKER and whose created_at falls on today's UTC date. A comment failing either test —
// a human note, a quoted marker mid-prose, yesterday's entry — contributes nothing.
// [LAW:parse-dont-validate] Each gated body is parsed back into the same Cost value costMarker wrote
// and folded by tallyCost, so this module never re-decides what a raw marker string means.
// [LAW:no-silent-failure] An entry whose figure is 'unknown' or unparseable raises unknownCount,
// never dropped, so the caller reports the day's spend as an honest lower bound rather than a
// silently-partial sum — the same shape summarizePriorReviews returns for a PR.
//
// THE SPEND EXCLUSION, IN PRACTICE. A subscription review's entry carries the NOTIONAL marker, so it
// lands in the `notional` tally and contributes nothing to `billed` — the day's dollar spend excludes
// it BY CONSTRUCTION, not by a guard, and no `usd` field exists on its cost for this fold to read.
// It is equally NOT an unknown billed entry: its spend is known exactly, and it is zero. The
// subscription's consumption stays visible in `notional` rather than becoming invisible.
function sumCostToday(comments, now) {
  const today = utcDay(now);
  const tallies = emptyTallies();
  for (const c of comments) {
    const body = typeof c.body === 'string' ? c.body : '';
    if (!body.trimStart().startsWith(LEDGER_MARKER)) continue;
    if (utcDay(c.created_at) !== today) continue;
    tallyCost(tallies, parseCost(body));
  }
  return tallies;
}

// [LAW:effects-at-boundaries] Effect: read the ledger issue's comments and return today's summed spend
// (the pure value the budget policy consumes). [LAW:no-silent-failure] pagination is exhausted so a
// busy day is summed in full, never truncated. An API error propagates — the boundary owns the safe
// fallback. `now` is passed in, not read here. [LAW:no-ambient-temporal-coupling]
async function readSpentToday(octokit, owner, repo, issueNumber, now) {
  const comments = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    comments.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return sumCostToday(comments, now);
}

// [LAW:effects-at-boundaries] Effect: append this review's actual cost as one immutable ledger entry,
// posted AFTER the review submits (the cost is known only then). One create, no read-modify-write.
// [LAW:no-silent-failure] an API error propagates so the boundary warns loudly and continues (the
// ledger then under-counts — a known lower bound), never a silent drop.
async function appendCost(octokit, owner, repo, issueNumber, usage, config) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: ledgerEntryBody(usage, config),
  });
}

module.exports = {
  LEDGER_MARKER,
  ledgerEntryBody,
  sumCostToday,
  readSpentToday,
  appendCost,
};
