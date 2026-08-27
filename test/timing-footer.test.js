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
