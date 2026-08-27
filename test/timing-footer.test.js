'use strict';
// zai-timing-31d.6 — the granular timing breakdown renders on every review, beside the cost.
//
// The one seam both sinks share is buildReviewFooter (src/run.js): the PR sink (submitReview) and
// the repo sink (renderRepoReport) each receive the footer STRING it builds, so asserting the
// breakdown into that string — and through renderRepoReport — is asserting both sinks.
// [LAW:single-enforcer] Nothing here recomputes a figure: every number is formatted from the
// schedule the fabricated pass recorded plus the one totalMs the run's clock minted.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Capture the loud channel: a timing render failure must WARN and omit, never fail the review.
const core = require('@actions/core');
let warnings;
core.warning = (m) => { warnings.push(String(m)); };
core.info = () => {};

const { buildReviewFooter } = require('../src/run');
const { parseCostRecord, emptyTally, tallyQuantity } = require('../src/usage');
const { renderRepoReport } = require('../src/report');

beforeEach(() => { warnings = []; });

const MIN = 60_000;
const at = (min) => `2026-08-23T12:${String(min).padStart(2, '0')}:00.000Z`;
const span = (fromMin, toMin) => ({ from: at(fromMin), to: at(toMin) });

const CONFIG = { name: 'zai', engine: 'claude-code', model: 'glm-5' };

// A fabricated pass with known timings: scout 2m, pass-0 workers 3m + 2m, one sweep worker 1m.
const SCHEDULE = {
  scopeConcurrency: 2,
  sweepCap: 1,
  scopeCount: 2,
  spawns: [
    { phase: 'scout', outcome: 'completed', usage: { span: span(0, 2) } },
    { phase: 'worker', scope: 'engine', pass: 0, outcome: 'completed', usage: { span: span(2, 5) } },
    { phase: 'worker', scope: 'transport', pass: 0, outcome: 'completed', usage: { span: span(2, 4) } },
    { phase: 'worker', scope: 'engine', pass: 1, outcome: 'completed', usage: { span: span(5, 6) } },
  ],
};

describe('the pr-mode footer', () => {
  test('renders the breakdown from a fabricated pass with known timings, beside the attribution', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 10 * MIN });
    assert.match(footer, /_Reviewed by config `zai`/);
    assert.match(footer, /_Timing: 10m00s total · spawns 8m00s \(4 attempt\(s\)\) — scout 2m00s · review 5m00s · sweep 1 1m00s · slowest scope: engine \(3m00s\) · 2 scope\(s\) at concurrency 2 over 2 pass\(es\) = 2 wave\(s\)_/);
    assert.match(footer, /<details>\n<summary>Timing by scope<\/summary>/);
    assert.equal(warnings.filter(w => w.includes('Timing')).length, 0);
  });

  test('a pass with a missing phase renders the gap explicitly', () => {
    const footer = buildReviewFooter(null, CONFIG, null, {
      schedule: { ...SCHEDULE, spawns: SCHEDULE.spawns.filter(s => s.phase !== 'scout') },
      totalMs: 10 * MIN,
    });
    assert.match(footer, /scout missing/);
  });

  test('an absent schedule renders the total with an explicit gap, never a silently omitted line', () => {
    // [LAW:no-silent-failure] the recorded absence — e.g. a review produced without a pass envelope.
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: null, totalMs: 17 * MIN + 1000 });
    assert.match(footer, /_Timing: 17m01s total · spawn breakdown unavailable — this run recorded no schedule_/);
  });

  // zai-timing-31d.2 — the posted body is the only store that survives to the next run, so the
  // figure a human reads and the figure a machine reads must be ONE figure. Asserting them together
  // is what forbids the drift: a footer that rendered 10m00s while recording something else would
  // make the PR's cumulative total disagree with the reviews it was summed from.
  test('the posted footer records the same total it rendered, invisibly, for the next run to read', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 10 * MIN });
    assert.match(footer, /_Timing: 10m00s total/);
    assert.equal(parseCostRecord(footer).totalMs, 10 * MIN);
  });

  // The record is not collateral damage of the render: the breakdown is the fragile part (it formats
  // a schedule), while the total is a number the run's clock minted. A pass that recorded no schedule
  // still knows how long it took, and the next run still gets its summand. [LAW:no-silent-failure]
  test('a review whose breakdown could not render still records its duration', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: null, totalMs: 3 * MIN });
    assert.equal(parseCostRecord(footer).totalMs, 3 * MIN);
  });

  test('a timing render failure omits the block loudly and never fails the review', () => {
    // [LAW:no-silent-failure] time is diagnostics; findings are the product. A wiring bug (no
    // totalMs minted) surfaces as a warning naming the cause, and the footer still carries the
    // attribution the review needs.
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: undefined });
    assert.match(footer, /_Reviewed by config `zai`/);
    assert.doesNotMatch(footer, /Timing:/);
    const timingWarnings = warnings.filter(w => w.includes('Timing'));
    assert.equal(timingWarnings.length, 1);
    assert.match(timingWarnings[0], /Timing breakdown unavailable/);
  });

  // The strongest form of "time never fails a review": no timing envelope at all. A caller that
  // forgot it, or a path built before this epic, must still get its attribution and its cost — the
  // parts that are the product — with the timing reported as the gap it is. [LAW:no-silent-failure]
  test('a footer built with no timing envelope at all still posts, loudly missing its timing', () => {
    const footer = buildReviewFooter(null, CONFIG);
    assert.match(footer, /_Reviewed by config `zai`/);
    assert.equal(parseCostRecord(footer).totalMs, null);
    assert.equal(warnings.filter(w => w.includes('Timing breakdown unavailable')).length, 1);
  });
});

// zai-timing-31d.3 — a PR reports the running total of agent time across ALL of its reviews.
//
// [LAW:behavior-not-structure] Every fixture here is a REAL footer this action built, read back
// through the one reader (parseCostRecord) and folded by the one fold — the same round trip a live
// run makes through GitHub. Nothing hand-writes a marker, so a change to how a duration is recorded
// cannot pass these tests while breaking the next run's ability to sum it.
describe("the PR's cumulative agent time", () => {
  // The fold summarizePriorReviews runs, exercised here over footers instead of an API fixture:
  // prior rounds in, one tally out. Its gate is asserted in transports.test.js.
  const priorRounds = (...footers) => footers.reduce(
    (tally, body) => tallyQuantity(tally, parseCostRecord(body).totalMs),
    emptyTally(),
  );
  const round = (ms) => buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: ms });

  test('given prior reviews carrying duration records, the footer shows the summed total', () => {
    const prior = priorRounds(round(3 * MIN), round(5 * MIN), round(4 * MIN));
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 2 * MIN, priorDuration: prior });
    // 3 + 5 + 4 prior, plus this run's 2 — every round recorded, so no '+' and nothing unrecorded.
    assert.match(footer, /_Timing: 2m00s total · PR time 14m00s across 4 rounds · spawns/);
    assert.doesNotMatch(footer, /unrecorded/);
  });

  test('with no prior records the total is this run\'s duration alone — no cumulative clause', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 2 * MIN, priorDuration: emptyTally() });
    assert.match(footer, /_Timing: 2m00s total · spawns/);
    assert.doesNotMatch(footer, /PR time/);
  });

  // [LAW:no-silent-failure] Every round posted before zai-timing-31d.2 recorded no duration. The
  // total is then a LOWER BOUND and says so — '+' plus the count of rounds it could not include —
  // rather than a partial sum passed off as complete, or a zero asserting those rounds were instant.
  test('rounds that recorded no duration render the total as a named lower bound', () => {
    const legacy = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE }); // pre-31d.2: no totalMs
    assert.equal(parseCostRecord(legacy).totalMs, null);
    const prior = priorRounds(round(6 * MIN), legacy, legacy);
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 4 * MIN, priorDuration: prior });
    assert.match(footer, /PR time 10m00s\+ across 4 rounds, 2 unrecorded/);
  });

  // THE TRAP. The record carries BOTH a spawn span (from/to) and the run's wall clock, and they look
  // redundant. They are not: the span is the spawn window, while the run also fetches a diff, waits
  // on a scout and posts a review. Measured on the live run that reviewed PR #138, totalMs was
  // 225201 ms against a 223475 ms span. Backfilling an unrecorded round from its span would report
  // the model's time as the run's — a silent under-report wearing the real measurement's name.
  test('an unrecorded round is NEVER backfilled from its spawn span', () => {
    const legacy = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE });
    const record = parseCostRecord(legacy);
    assert.equal(record.totalMs, null);
    const prior = priorRounds(legacy);
    assert.equal(prior.total, 0);           // nothing derived from the span
    assert.equal(prior.unknownCount, 1);    // and the round is still visible as a round
  });

  // Repo mode has no cross-run store to read, so it reports per-run time only — by construction
  // (priorDuration is never passed) rather than by a flag anyone has to remember. [LAW:no-mode-explosion]
  test('repo mode reports per-run time only', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 10 * MIN });
    assert.match(footer, /_Timing: 10m00s total · spawns/);
    assert.doesNotMatch(footer, /PR time/);
  });

  // The cumulative clause is a value on the head every timing line shares, not a second line shape:
  // a run that recorded no schedule still reports the PR's total beside its own. [LAW:dataflow-not-control-flow]
  test('the cumulative total survives a run that recorded no schedule', () => {
    const prior = priorRounds(round(9 * MIN));
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: null, totalMs: 1 * MIN, priorDuration: prior });
    assert.match(footer, /_Timing: 1m00s total · PR time 10m00s across 2 rounds · spawn breakdown unavailable/);
  });

  // Time is diagnostics; findings are the product. A cumulative figure never becomes a reason a
  // review fails to post. [LAW:no-silent-failure]
  test('a broken totalMs omits the block loudly, cumulative clause and all, and still posts', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: undefined, priorDuration: priorRounds(round(9 * MIN)) });
    assert.match(footer, /_Reviewed by config `zai`/);
    assert.doesNotMatch(footer, /Timing:/);
    assert.equal(warnings.filter(w => w.includes('Timing breakdown unavailable')).length, 1);
  });
});

describe('the repo-mode report', () => {
  test('renders the same breakdown through the footer it already carries', () => {
    const footer = buildReviewFooter(null, CONFIG, null, { schedule: SCHEDULE, totalMs: 10 * MIN });
    const report = renderRepoReport({
      reviewerName: 'Review Agent', scope: '',
      review: { summary: 'Clean.', findings: [] },
      footer,
    });
    assert.match(report, /_Timing: 10m00s total/);
    assert.match(report, /slowest scope: engine \(3m00s\)/);
  });
});
