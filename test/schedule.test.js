'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { spanMs, sumMs, describeSchedule } = require('../src/schedule');

const at = (min) => `2026-08-22T03:${String(min).padStart(2, '0')}:00.000Z`;
const span = (fromMin, toMin) => ({ from: at(fromMin), to: at(toMin) });
const MIN = 60_000;

describe('spanMs', () => {
  test('a span is its duration in milliseconds', () => {
    assert.equal(spanMs(span(0, 2)), 2 * MIN);
  });
  test('an absent span is a recorded absence, never a fabricated zero', () => {
    assert.equal(spanMs(undefined), null);
    assert.equal(spanMs(null), null);
  });
});

describe('sumMs', () => {
  test('sums the present durations, ignoring recorded absences', () => {
    assert.equal(sumMs([MIN, null, 2 * MIN]), 3 * MIN);
  });
  test('all-absent sums to null, matching the usage fold convention', () => {
    assert.equal(sumMs([null, null]), null);
    assert.equal(sumMs([]), null);
  });
});

// The accept case (zai-timing-31d.5): a fabricated pass with known per-spawn durations — a scout,
// four scopes at concurrency 2, one convergence sweep — must report the right scout time, the right
// per-scope times, the right per-sweep grouping, and the wave count derived from scope count and
// concurrency. [LAW:behavior-not-structure] the assertions read only the derived breakdown.
describe('describeSchedule', () => {
  const worker = (scope, pass, fromMin, toMin, outcome = 'completed') =>
    ({ phase: 'worker', scope, pass, outcome, usage: { span: span(fromMin, toMin) } });
  const schedule = {
    scopeConcurrency: 2,
    sweepCap: 2,
    scopeCount: 4,
    spawns: [
      { phase: 'scout', outcome: 'completed', usage: { span: span(0, 2) } },
      worker('s1', 0, 2, 4),
      worker('s2', 0, 2, 5),
      worker('s3', 0, 4, 6),
      worker('s4', 0, 5, 6),
      worker('s1', 1, 6, 7),
      worker('s2', 1, 6, 8),
      worker('s3', 1, 7, 8),
      worker('s4', 1, 8, 9),
    ],
  };

  test('reports the scout time, per-scope times grouped per pass, and the derived wave count', () => {
    const d = describeSchedule(schedule);
    assert.equal(d.scoutMs, 2 * MIN);
    assert.equal(d.passes.length, 2);
    assert.deepEqual(d.passes.map(p => p.pass), [0, 1]);
    assert.deepEqual(
      d.passes[0].spawns.map(({ scope, ms }) => ({ scope, ms })),
      [{ scope: 's1', ms: 2 * MIN }, { scope: 's2', ms: 3 * MIN }, { scope: 's3', ms: 2 * MIN }, { scope: 's4', ms: 1 * MIN }],
    );
    assert.deepEqual(
      d.passes[1].spawns.map(({ scope, ms }) => ({ scope, ms })),
      [{ scope: 's1', ms: 1 * MIN }, { scope: 's2', ms: 2 * MIN }, { scope: 's3', ms: 1 * MIN }, { scope: 's4', ms: 1 * MIN }],
    );
    // 4 scopes at concurrency 2 = 2 waves per pass; 2 passes actually ran = 4 waves. Derived, never
    // stored — the record cannot contradict its own arithmetic. [LAW:one-source-of-truth]
    assert.equal(d.wavesPerPass, 2);
    assert.equal(d.waveCount, 4);
    // The scheduling facts are echoed as recorded.
    assert.equal(d.scopeCount, 4);
    assert.equal(d.scopeConcurrency, 2);
    assert.equal(d.sweepCap, 2);
  });

  test('a deadline-killed scope still contributes its elapsed time to the breakdown', () => {
    const d = describeSchedule({
      scopeConcurrency: 2,
      sweepCap: 0,
      scopeCount: 2,
      spawns: [
        { phase: 'scout', outcome: 'completed', usage: { span: span(0, 1) } },
        worker('ok', 0, 1, 3),
        worker('killed', 0, 1, 5, 'failed'),
      ],
    });
    assert.deepEqual(d.passes[0].spawns[1], { scope: 'killed', outcome: 'failed', ms: 4 * MIN });
  });

  test('a retried attempt is its own row beside the attempt that settled', () => {
    const d = describeSchedule({
      scopeConcurrency: 1,
      sweepCap: 0,
      scopeCount: 1,
      spawns: [
        { phase: 'scout', outcome: 'completed', usage: { span: span(0, 1) } },
        worker('s1', 0, 1, 4, 'retried'),
        worker('s1', 0, 5, 7),
      ],
    });
    assert.deepEqual(
      d.passes[0].spawns,
      [{ scope: 's1', outcome: 'retried', ms: 3 * MIN }, { scope: 's1', outcome: 'completed', ms: 2 * MIN }],
    );
  });

  test('a spawn that never ran (usage null) reports a null duration, never zero', () => {
    const d = describeSchedule({
      scopeConcurrency: 1,
      sweepCap: 0,
      scopeCount: 1,
      spawns: [{ phase: 'worker', scope: 's1', pass: 0, outcome: 'failed', usage: null }],
    });
    assert.equal(d.scoutMs, null); // no scout record at all
    assert.deepEqual(d.passes[0].spawns, [{ scope: 's1', outcome: 'failed', ms: null }]);
  });

  test('a scout retried before settling reports the summed spawn time of all its attempts', () => {
    const d = describeSchedule({
      scopeConcurrency: 1,
      sweepCap: 0,
      scopeCount: 1,
      spawns: [
        { phase: 'scout', outcome: 'retried', usage: { span: span(0, 2) } },
        { phase: 'scout', outcome: 'completed', usage: { span: span(3, 4) } },
      ],
    });
    assert.equal(d.scoutMs, 3 * MIN);
  });
});
