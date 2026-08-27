'use strict';

// The pass's SCHEDULE, derived — the facts that turn per-spawn time into wall-clock time.
//
// [FRAMING:representation] Summed spawn time and elapsed wall time are different numbers, and their
// ratio is the diagnosis: an operator who sees only a total cannot tell a slow model (fix: faster
// engine) from too many waves (fix: raise concurrency) from too many sweeps (fix: lower sweepCap) —
// three causes with opposite remedies. The schedule value recorded by runMultiScopePass carries the
// facts; this module derives everything derivable from them, so the record can never contradict
// itself — wave count is never STORED anywhere, it always falls out of scope count and concurrency.
// [LAW:one-source-of-truth]
//
// The recorded schedule value:
//   { scopeConcurrency, sweepCap, scopeCount, spawns: SpawnRecord[] }
// where each SpawnRecord is a discriminated value, one per engine spawn ATTEMPT:
//   { phase: 'scout',                     outcome, usage }
//   { phase: 'worker', scope, pass,      outcome, usage }
// pass 0 is the review of record; pass 1..N are convergence sweeps. outcome is
// 'completed' (the spawn settled with a result), 'retried' (a transient attempt retried in place —
// its burned time is real and appears as its own record), or 'failed' (the settling attempt failed:
// deadline-killed, retry-exhausted, or non-retryable). usage is the spawn's Usage record — its
// host-stamped span carries the duration — or null when nothing ran (a pre-spawn refusal).
// [LAW:types-are-the-program]

// [LAW:one-source-of-truth] THIS module owns the SpawnRecord shape: the producer (the spawn seam in
// src/multiscope.js) mints every record through spawnRecord below, and the consumer
// (describeSchedule) dispatches exhaustively on the same vocabulary — so a renamed field or a new
// outcome value fails loudly at the mint or the derive, never as a silently-wrong breakdown.
// [LAW:parse-dont-validate] the constructor is the checkpoint: a SpawnRecord exists only by passing
// it, so everything downstream reads the stamp instead of re-checking the shape.
const SPAWN_OUTCOMES = new Set(['completed', 'retried', 'failed']);
function spawnRecord(tag, outcome, usage) {
  if (tag.phase !== 'scout' && tag.phase !== 'worker') {
    throw new Error(`spawnRecord: unknown phase ${JSON.stringify(tag.phase)}`);
  }
  if (tag.phase === 'worker' && (typeof tag.scope !== 'string' || !Number.isInteger(tag.pass) || tag.pass < 0)) {
    throw new Error(`spawnRecord: a worker tag needs a scope name and a non-negative pass index (got ${JSON.stringify(tag)})`);
  }
  if (!SPAWN_OUTCOMES.has(outcome)) {
    throw new Error(`spawnRecord: unknown outcome ${JSON.stringify(outcome)}`);
  }
  return { ...tag, outcome, usage };
}

// [LAW:effects-at-boundaries] Pure: a span's duration in milliseconds. Absent span → null — a
// recorded absence (nothing ran, or the failure predated the spawn), never a fabricated zero.
// [LAW:parse-dont-validate] spans arrive host-stamped by runEngine (ISO-8601 UTC, both ends), so
// there is nothing to defend against here: absent is the only legal alternative to well-formed.
function spanMs(span) {
  if (!span) return null;
  return Date.parse(span.to) - Date.parse(span.from);
}

// [LAW:effects-at-boundaries] Pure: sum the present durations; all-absent sums to null, matching
// sumUsage's convention (a fold over nothing reports nothing, never a fabricated zero).
function sumMs(values) {
  const present = values.filter(v => v != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0);
}

// [LAW:effects-at-boundaries] Pure: derive the reportable breakdown from a recorded schedule.
// Returns {
//   scoutMs,            // the scout phase's spawn time (all scout attempts summed), null if unclocked
//   passes: [           // worker spawns grouped by pass index, ascending; order within a pass is
//     { pass, spawns: [{ scope, outcome, ms }] }   // settle order, as recorded
//   ],
//   scopeCount, scopeConcurrency, sweepCap,        // the scheduling facts, echoed as recorded
//   wavesPerPass,       // ceil(scopeCount / scopeConcurrency) — the pool's sequential depth per pass
//   waveCount,          // wavesPerPass × passes actually run — DERIVED, so it cannot contradict
// }
// [LAW:dataflow-not-control-flow] Grouping is a fold over the records; a pass that spawned nothing
// (every scope refused pre-spawn) simply contributes no group, so waveCount reflects work that
// actually ran, never work that was merely planned.
function describeSchedule({ scopeConcurrency, sweepCap, scopeCount, spawns }) {
  const scoutDurations = [];
  const byPass = new Map();
  // [LAW:no-silent-failure] The dispatch is EXHAUSTIVE over the phase vocabulary this module owns:
  // a record with a phase this fold doesn't recognize would otherwise vanish from the breakdown —
  // the exact drift the shared constructor exists to make impossible — so it throws instead.
  for (const s of spawns) {
    if (s.phase === 'scout') {
      scoutDurations.push(spanMs(s.usage && s.usage.span));
    } else if (s.phase === 'worker') {
      if (!byPass.has(s.pass)) byPass.set(s.pass, []);
      byPass.get(s.pass).push({ scope: s.scope, outcome: s.outcome, ms: spanMs(s.usage && s.usage.span) });
    } else {
      throw new Error(`describeSchedule: unknown phase ${JSON.stringify(s.phase)} in spawn record`);
    }
  }
  const scoutMs = sumMs(scoutDurations);
  const passes = [...byPass.keys()].sort((a, b) => a - b).map(pass => ({ pass, spawns: byPass.get(pass) }));
  const wavesPerPass = Math.ceil(scopeCount / scopeConcurrency);
  return {
    scoutMs,
    passes,
    scopeCount,
    scopeConcurrency,
    sweepCap,
    wavesPerPass,
    waveCount: wavesPerPass * passes.length,
  };
}

module.exports = { spawnRecord, spanMs, sumMs, describeSchedule };
