'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DeadlineExceededError, parseTimeBudgetMinutes, mintDeadline, remainingMs } = require('../src/deadline');
const { isRetryableSpawnError, TransientError } = require('../src/failover');

// ── the time-budget input, parsed strictly (mirrors parseMaxRounds) ───────────────────────────────
describe('parseTimeBudgetMinutes', () => {
  test('accepts a run of digits', () => {
    assert.equal(parseTimeBudgetMinutes('25'), 25);
    assert.equal(parseTimeBudgetMinutes(' 40 '), 40);
  });
  test('0 and empty are the disabled sentinel', () => {
    assert.equal(parseTimeBudgetMinutes('0'), 0);
    assert.equal(parseTimeBudgetMinutes(''), 0);
  });
  test('rejects anything else loudly — a typo must never silently disable the budget', () => {
    // [LAW:no-silent-failure] `parseInt("25m")` would yield 25 and "twenty" would yield NaN→0
    // (= budget off); both are misconfigurations that must red the run, not decide policy.
    for (const bad of ['25m', 'twenty', '-1', '2.5', '25 minutes']) {
      assert.throws(() => parseTimeBudgetMinutes(bad), /TIME_BUDGET_MINUTES must be a non-negative integer/);
    }
  });
});

describe('mintDeadline / remainingMs', () => {
  test('a positive budget mints an absolute epoch deadline', () => {
    assert.equal(mintDeadline(1_000, 25), 1_000 + 25 * 60_000);
  });
  test('a zero budget mints null — no deadline', () => {
    assert.equal(mintDeadline(1_000, 0), null);
  });
  test('remainingMs counts down and goes negative past the deadline', () => {
    assert.equal(remainingMs(5_000, 2_000), 3_000);
    assert.equal(remainingMs(5_000, 6_000), -1_000);
  });
  test('a null deadline reads as Infinity, so every bound resolves to the adapter cap and every gate stays open', () => {
    // [LAW:dataflow-not-control-flow] the no-budget path is the same code path with a different
    // value: Math.min(cap, Infinity) === cap and Infinity > 0 is always true.
    assert.equal(remainingMs(null, 999_999), Infinity);
    assert.equal(Math.min(3_000_000, remainingMs(null, 0)), 3_000_000);
  });
});

// ── the deadline kill's place in the error vocabulary ─────────────────────────────────────────────
describe('DeadlineExceededError retry policy', () => {
  test('is not retryable in place — a fresh spawn cannot fit in a spent budget', () => {
    assert.equal(isRetryableSpawnError(new DeadlineExceededError('x')), false);
  });
  test('is not transient — config-level failover must not restart the pass at the deadline', () => {
    assert.equal(new DeadlineExceededError('x') instanceof TransientError, false);
  });
});
