'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { spawnRecord, scheduleRecord, spanMs, sumMs, describeSchedule } = require('../src/schedule');

const at = (min) => `2026-08-22T03:${String(min).padStart(2, '0')}:00.000Z`;
const span = (fromMin, toMin) => ({ from: at(fromMin), to: at(toMin) });
const MIN = 60_000;

// The one owner of the SpawnRecord shape: a drifted producer fails at the mint, never as a
// silently-wrong breakdown. [LAW:one-source-of-truth]
describe('spawnRecord', () => {
  test('mints scout and worker records', () => {
    assert.deepEqual(spawnRecord({ phase: 'scout' }, 'completed', null), { phase: 'scout', outcome: 'completed', usage: null });
    assert.deepEqual(
      spawnRecord({ phase: 'worker', scope: 's1', pass: 2 }, 'retried', { span: span(0, 1) }),
      { phase: 'worker', scope: 's1', pass: 2, outcome: 'retried', usage: { span: span(0, 1) } },
    );
  });
  test('rejects an unknown phase loudly', () => {
    assert.throws(() => spawnRecord({ phase: 'sweeper' }, 'completed', null), /unknown phase "sweeper"/);
  });
  test('rejects a worker tag missing its scope name or pass index', () => {
    assert.throws(() => spawnRecord({ phase: 'worker', scope: 's1' }, 'completed', null), /non-negative pass index/);
    assert.throws(() => spawnRecord({ phase: 'worker', pass: 0 }, 'completed', null), /scope name/);
  });
  test('rejects an outcome outside the vocabulary', () => {
    assert.throws(() => spawnRecord({ phase: 'scout' }, 'killed', null), /unknown outcome "killed"/);
  });
});

// The outer envelope's mint, mirroring spawnRecord: a drifted field name fails here, never as
// describeSchedule deriving NaN waves from an undefined count. [LAW:one-source-of-truth]
describe('scheduleRecord', () => {
  const good = { scopeConcurrency: 2, sweepCap: 1, scopeCount: 3, spawns: [] };
  test('mints the envelope as given', () => {
    assert.deepEqual(scheduleRecord(good), good);
  });
  test('rejects a missing or out-of-domain field loudly', () => {
    assert.throws(() => scheduleRecord({ ...good, scopeConcurrency: 0 }), /scopeConcurrency must be a positive integer/);
    assert.throws(() => scheduleRecord({ ...good, sweepCap: -1 }), /sweepCap must be a non-negative integer/);
    assert.throws(() => scheduleRecord({ ...good, scopeCount: undefined }), /scopeCount must be a positive integer/);
    assert.throws(() => scheduleRecord({ ...good, spawns: undefined }), /spawns must be an array/);
  });
});

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
    // 4 distinct scopes spawned at concurrency 2 = 2 waves in each pass; 4 waves total. Derived from
    // the records, never stored — the count cannot contradict its own arithmetic. [LAW:one-source-of-truth]
    assert.deepEqual(d.passes.map(p => p.waves), [2, 2]);
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
    // Two records, ONE scope: a retried attempt reoccupies the same wave slot, never inflates waves.
    assert.equal(d.passes[0].waves, 1);
    assert.equal(d.waveCount, 1);
  });

  test('a pass the budget cut short mid-wave reports only the waves its spawned scopes filled', () => {
    // The plan said 3 scopes at concurrency 2 (2 waves), but shouldStart refused the third scope
    // before it spawned: only wave 1 ran, and the count must say so — an operator diagnosing a
    // budget-exhausted run must not be told to raise concurrency for a wave that never happened.
    const d = describeSchedule({
      scopeConcurrency: 2,
      sweepCap: 0,
      scopeCount: 3,
      spawns: [
        { phase: 'scout', outcome: 'completed', usage: { span: span(0, 1) } },
        worker('s1', 0, 1, 3),
        worker('s2', 0, 1, 4),
        // s3 never spawned — no record, exactly as the pool's pre-spawn refusal leaves it.
      ],
    });
    assert.equal(d.passes[0].waves, 1);
    assert.equal(d.waveCount, 1);
    assert.equal(d.scopeCount, 3); // the plan is still echoed; the gap between them IS the diagnosis
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

  test('a record with a phase outside the vocabulary fails the derive loudly, never vanishing', () => {
    assert.throws(
      () => describeSchedule({ scopeConcurrency: 1, sweepCap: 0, scopeCount: 1, spawns: [{ phase: 'sweeper', outcome: 'completed', usage: null }] }),
      /unknown phase "sweeper"/,
    );
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
