'use strict';

// [FRAMING:parts-and-seams] The review's wall-clock budget. A hosted run lives under a hard outer
// cap (the workflow's timeout-minutes) whose only tool is cancellation — which discards every
// finding the run has collected but not yet submitted. This module makes the deadline OWNED state
// instead of ambient luck [LAW:no-ambient-temporal-coupling]: the run boundary mints one absolute
// deadline from the TIME_BUDGET_MINUTES input, and every scheduling decision downstream (start a
// scope worker? run another sweep? how long may this spawn live?) reads the SAME value — so the
// review finishes and submits BEFORE the outer kill, shedding coverage loudly instead of dying
// with a full pocket of findings. [LAW:one-source-of-truth] the deadline is minted exactly once;
// nothing downstream re-reads the input or re-decides the budget.

// [LAW:types-are-the-program] "The time budget expired" is a distinct fact from "this engine hung
// past its own sanity cap" — the first is planned degradation the scheduler absorbs scope-by-scope,
// the second is an engine failure that reds the attempt. Two meanings, two types: the deadline kill
// carries this class so the worker pool can absorb it as "scope unreviewed" without touching the
// fail-loud path that protects sibling findings. It is NOT retryable and NOT transient by
// construction: retryTransientSpawn passes it through (isRetryableSpawnError is false) and
// produceReview's `instanceof TransientError` gate rethrows it immediately — no failover restart
// can fit in a budget that has already run out.
class DeadlineExceededError extends Error {
  constructor(message) {
    super(message);
    // The whole point of the type is being distinguishable — including in serialized form:
    // without this, err.name/String(err) report a generic "Error" and every log or triage
    // surface collapses planned degradation back into an engine failure.
    this.name = 'DeadlineExceededError';
  }
}

// [LAW:one-source-of-truth] The operator remedy, stated once: every deadline-exhaustion message —
// the spawn refusal, the mid-spawn kill, the nothing-completed failure — names the same two knobs
// the same way, so the fix is never phrased three drifting ways.
const BUDGET_REMEDY = 'Raise TIME_BUDGET_MINUTES (and the workflow job\'s timeout-minutes above it) or split the change.';

// [LAW:no-silent-failure] Parse the budget strictly, mirroring parseMaxRounds: a typo like "25m"
// or "twenty" must red the run, never silently disable the budget (the failure mode that would
// resurrect the empty-handed cancel this module exists to prevent). The domain is a non-negative
// integer of minutes; 0 = disabled, matching MAX_REVIEW_ROUNDS' 0-sentinel convention. Empty (an
// explicitly cleared input) is disabled; unset gets action.yml's default from the runner.
function parseTimeBudgetMinutes(raw) {
  const s = String(raw).trim();
  if (s === '') return 0;
  const minutes = parseInt(s, 10);
  // The safe-integer gate closes the overflow hole in the digits regex — applied to the DERIVED
  // milliseconds, because that product is what the deadline arithmetic actually uses: a minutes
  // value can itself be a safe integer while minutes * 60_000 is not, minting an imprecise
  // never-arriving deadline, and either way the budget is silently DISABLED by the exact kind of
  // garbage the strict parse exists to refuse. Soundness of the arithmetic is the bound — no
  // invented policy cap beyond it: a safe-but-absurd value is the operator's visible choice.
  if (!/^\d+$/.test(s) || !Number.isSafeInteger(minutes * 60_000)) {
    throw new Error(`TIME_BUDGET_MINUTES must be a non-negative integer of minutes (0 = no budget); got "${raw}".`);
  }
  return minutes;
}

// [LAW:effects-at-boundaries] Pure: the run boundary passes its own clock reading. A positive
// budget yields an absolute epoch-ms deadline; 0 yields null — "no budget", the value that makes
// every downstream bound resolve to the adapter's own cap (see remainingMs).
// [LAW:parse-dont-validate] Each boundary proves what it can see: the parse keeps the millisecond
// PRODUCT safe, but only here do both operands exist — a product that is safe alone can leave the
// safe range once the epoch nowMs is added, minting an imprecise never-arriving deadline that
// silently disables the budget. The SUM is what every remainingMs comparison uses, so the sum is
// what this boundary refuses to mint unsound.
function mintDeadline(nowMs, budgetMinutes) {
  if (budgetMinutes <= 0) return null;
  const deadline = nowMs + budgetMinutes * 60_000;
  if (!Number.isSafeInteger(deadline)) {
    throw new Error(`TIME_BUDGET_MINUTES is too large to mint a sound deadline (${budgetMinutes} minutes from now overflows safe integer arithmetic).`);
  }
  return deadline;
}

// [LAW:dataflow-not-control-flow] Time remaining as a value every consumer can use uniformly: a
// null deadline reads as Infinity, so `Math.min(cap, remainingMs(...))` is the adapter cap and
// `remainingMs(...) > 0` is always true — the no-budget path is the same code path with a
// different value, never a branch per consumer.
function remainingMs(deadline, nowMs) {
  return deadline === null || deadline === undefined ? Infinity : deadline - nowMs;
}

module.exports = { DeadlineExceededError, BUDGET_REMEDY, parseTimeBudgetMinutes, mintDeadline, remainingMs };
