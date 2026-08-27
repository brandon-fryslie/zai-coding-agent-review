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

describe('spanMs — malformed pairs', () => {
  test('a negative or NaN difference is not a duration and resolves to the typed absence', () => {
    // [LAW:parse-dont-validate] the one boundary where timestamps become a duration: a backward
    // clock step or malformed stamp renders 'unclocked' downstream, never '-5s' or 'NaNs'.
    assert.equal(spanMs({ from: at(5), to: at(3) }), null);
    assert.equal(spanMs({ from: 'not-a-timestamp', to: at(3) }), null);
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

// --- rendering (zai-timing-31d.6) ---

describe('formatMs', () => {
  const { formatMs } = require('../src/schedule');
  test('renders seconds, minutes and hours at footer-line density', () => {
    assert.equal(formatMs(45_000), '45s');
    assert.equal(formatMs(128_000), '2m08s');
    assert.equal(formatMs(1021_000), '17m01s');
    assert.equal(formatMs(3728_000), '1h02m08s');
    assert.equal(formatMs(0), '0s');
  });
  test('a recorded absence renders as the word for it, never a fabricated zero', () => {
    // [LAW:no-silent-failure] an unclocked spawn took time we cannot state; '0s' would state one.
    assert.equal(formatMs(null), 'unclocked');
  });
});

// The live run log's running-total clause (zai-timing-31d.7): one clause shape, absences rendered
// as their words — never a fabricated '0s' elapsed or an invented budget. [LAW:no-silent-failure]
describe('renderRunningTotal', () => {
  const { renderRunningTotal } = require('../src/schedule');
  test('renders elapsed against the budget at formatMs density', () => {
    assert.equal(renderRunningTotal(392_000, 900_000), 'elapsed 6m32s of 15m00s budget');
  });
  test('a run with no budget says so, through the same clause', () => {
    assert.equal(renderRunningTotal(392_000, null), 'elapsed 6m32s (no budget)');
  });
  test('an unknown start renders the recorded absence, never a second clock read', () => {
    assert.equal(renderRunningTotal(null, null), 'elapsed unclocked (no budget)');
    assert.equal(renderRunningTotal(null, 900_000), 'elapsed unclocked of 15m00s budget');
  });
  test('a backward clock step or malformed figure collapses to the absence spanMs uses, never "-5s"', () => {
    // [LAW:single-enforcer] the same asDuration predicate spanMs applies to a span's stamps.
    assert.equal(renderRunningTotal(-5_000, 900_000), 'elapsed unclocked of 15m00s budget');
    assert.equal(renderRunningTotal(NaN, null), 'elapsed unclocked (no budget)');
  });
});

// Exported vocabulary for the live log's pass lines: the same labels the breakdown table uses.
describe('passLabel', () => {
  const { passLabel } = require('../src/schedule');
  test('pass 0 is the review of record; later passes are sweeps', () => {
    assert.equal(passLabel(0), 'review');
    assert.equal(passLabel(2), 'sweep 2');
  });
});

describe('renderTimingBreakdown', () => {
  const { renderTimingBreakdown } = require('../src/schedule');
  const worker = (scope, pass, fromMin, toMin, outcome = 'completed') =>
    ({ phase: 'worker', scope, pass, outcome, usage: { span: span(fromMin, toMin) } });
  // The hand-measured shape from the epic: a scout, then two passes of workers.
  const schedule = {
    scopeConcurrency: 2,
    sweepCap: 1,
    scopeCount: 2,
    spawns: [
      { phase: 'scout', outcome: 'completed', usage: { span: span(0, 2) } },
      worker('engine', 0, 2, 5),
      worker('transport', 0, 2, 4),
      worker('engine', 1, 5, 6),
      worker('transport', 1, 5, 7),
    ],
  };

  test('the summary line answers "why was this slow?": total, spawn time, phase split, slowest scope, schedule sentence', () => {
    const block = renderTimingBreakdown(schedule, 10 * MIN);
    const line = block.split('\n')[0];
    assert.match(line, /^_Timing: 10m00s total/);
    // spawn time inside the total: 2 + 3 + 2 + 1 + 2 = 10 minutes across 5 attempts
    assert.match(line, /10m00s \(5 attempt\(s\)\)/);
    assert.match(line, /scout 2m00s/);
    assert.match(line, /review 5m00s/);
    assert.match(line, /sweep 1 3m00s/);
    // the slowest CLOCKED worker attempt, named — pass 0's engine at 3 minutes
    assert.match(line, /slowest scope: engine \(3m00s\)/);
    // the schedule sentence that turns spawn time into wall time
    assert.match(line, /2 scope\(s\) at concurrency 2 over 2 pass\(es\) = 2 wave\(s\)/);
  });

  test('the per-attempt table sits behind <details>, one row per spawn attempt', () => {
    const block = renderTimingBreakdown(schedule, 10 * MIN);
    assert.match(block, /<details>\n<summary>Timing by scope<\/summary>/);
    assert.match(block, /\| scout \| — \| completed \| 2m00s \|/);
    assert.match(block, /\| review \| engine \| completed \| 3m00s \|/);
    assert.match(block, /\| sweep 1 \| transport \| completed \| 2m00s \|/);
  });

  test('a missing phase renders as an explicit gap, never a silently omitted clause', () => {
    // [LAW:no-silent-failure] a schedule with no scout record (the phase never ran or its record
    // was lost) names the gap rather than pretending the phase was free.
    const block = renderTimingBreakdown({
      scopeConcurrency: 1, sweepCap: 0, scopeCount: 1,
      spawns: [worker('only', 0, 0, 1)],
    }, 2 * MIN);
    assert.match(block, /scout missing/);
  });

  test('an unclocked spawn marks its phase sum as a lower bound and never wins slowest-scope', () => {
    const block = renderTimingBreakdown({
      scopeConcurrency: 2, sweepCap: 0, scopeCount: 2,
      spawns: [
        { phase: 'scout', outcome: 'completed', usage: { span: span(0, 1) } },
        worker('clocked', 0, 1, 3),
        { phase: 'worker', scope: 'unclocked-scope', pass: 0, outcome: 'failed', usage: null },
      ],
    }, 5 * MIN);
    // the pass sum carries the '+' the cost tally already taught the reader
    assert.match(block, /review 2m00s\+/);
    assert.match(block, /slowest scope: clocked \(2m00s\)/);
    // the table still rows the unclocked attempt, explicitly
    assert.match(block, /\| review \| unclocked-scope \| failed \| unclocked \|/);
  });

  test('a scope name cannot inject table or markdown structure into the rendered block', () => {
    // Scope names are LLM-minted free text; the renderer's one escape kills the characters that
    // ARE the structure (pipes, newlines) and neuters markdown/HTML metacharacters.
    const block = renderTimingBreakdown({
      scopeConcurrency: 1, sweepCap: 0, scopeCount: 1,
      spawns: [worker('a | b\n<x>_y_', 0, 0, 1)],
    }, MIN);
    assert.doesNotMatch(block, /\| a \| b/);
    assert.match(block, /a \\\| b &lt;x&gt;\\_y\\_/);
    // the newline collapsed: every table row is still one line
    for (const line of block.split('\n')) assert.doesNotMatch(line, /^\| review \|$/);
  });

  test('a wholly unclocked worker phase reports slowest scope as unclocked, never a fabricated winner', () => {
    const block = renderTimingBreakdown({
      scopeConcurrency: 1, sweepCap: 0, scopeCount: 1,
      spawns: [{ phase: 'worker', scope: 's', pass: 0, outcome: 'failed', usage: null }],
    }, MIN);
    assert.match(block, /slowest scope: unclocked/);
  });

  test('a null schedule renders the total with an explicit gap, never a silently omitted line', () => {
    // [LAW:no-silent-failure] the recorded absence (a review produced without a pass envelope).
    const block = renderTimingBreakdown(null, 1021_000);
    assert.equal(block, '_Timing: 17m01s total · spawn breakdown unavailable — this run recorded no schedule_');
  });

  test('a nonsense total is a wiring bug thrown loudly, never rendered', () => {
    assert.throws(() => renderTimingBreakdown(null, undefined), /totalMs must be a non-negative finite number/);
    assert.throws(() => renderTimingBreakdown(null, -5), /totalMs must be a non-negative finite number/);
  });
});
