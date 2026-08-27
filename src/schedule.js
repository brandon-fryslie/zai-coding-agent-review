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
// src/multiscope.js) mints every record through spawnRecord below, so a drifted tag or outcome
// fails loudly at the mint, never as a silently-wrong breakdown. [LAW:parse-dont-validate] the
// constructor is the checkpoint: a SpawnRecord exists only by passing it, so everything downstream
// reads the stamp instead of re-checking the shape. [LAW:single-enforcer] the mint is the ONE
// checkpoint for the vocabulary — describeSchedule does not re-validate `outcome` (it carries it
// through without branching); its phase throw is exhaustive DISPATCH, not a second check, because
// phase is the one field the fold branches on.
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

// [LAW:one-source-of-truth] The OUTER shape gets the same owner the inner one has: the pass builds
// its schedule envelope through this mint, so a renamed or dropped field fails loudly here instead
// of surfacing as describeSchedule deriving NaN waves from an undefined count. The domains mirror
// the pass's own entry gates (positive concurrency, non-negative sweep cap); the gates exist to
// fail BEFORE spawns are spent, this mint to stamp the record — same predicate, different instant.
function scheduleRecord({ scopeConcurrency, sweepCap, scopeCount, spawns }) {
  if (!Number.isInteger(scopeConcurrency) || scopeConcurrency < 1) {
    throw new Error(`scheduleRecord: scopeConcurrency must be a positive integer (got ${JSON.stringify(scopeConcurrency)})`);
  }
  if (!Number.isInteger(sweepCap) || sweepCap < 0) {
    throw new Error(`scheduleRecord: sweepCap must be a non-negative integer (got ${JSON.stringify(sweepCap)})`);
  }
  if (!Number.isInteger(scopeCount) || scopeCount < 1) {
    throw new Error(`scheduleRecord: scopeCount must be a positive integer (got ${JSON.stringify(scopeCount)})`);
  }
  if (!Array.isArray(spawns)) {
    throw new Error('scheduleRecord: spawns must be an array of spawn records');
  }
  return { scopeConcurrency, sweepCap, scopeCount, spawns };
}

// [LAW:effects-at-boundaries] Pure: a span's duration in milliseconds. Absent span → null — a
// recorded absence (nothing ran, or the failure predated the spawn), never a fabricated zero.
// [LAW:parse-dont-validate] This is the ONE boundary where two timestamps become a duration, so
// it is also where a pair that cannot make one resolves: a NaN difference (a malformed stamp) or
// a negative one (a backward clock step between the host's two reads) is not a duration, and
// both collapse to the same typed absence — rendered 'unclocked', never '-5s' or 'NaNs' in a
// posted footer, and never a throw that would cost the whole breakdown for one bad span.
// [LAW:no-silent-failure] 'unclocked' IS the loud form here: the absence is printed, not skipped.
function spanMs(span) {
  if (!span) return null;
  const ms = Date.parse(span.to) - Date.parse(span.from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
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
//   scouts: [           // one row per scout ATTEMPT, as recorded — scoutMs derives from these,
//     { outcome, ms }   // so the summed figure and the per-attempt rows cannot disagree
//   ],
//   passes: [          // worker spawns grouped by pass index, ascending; order within a pass is
//     { pass, spawns: [{ scope, outcome, ms }], waves }   // settle order, as recorded
//   ],
//   scopeCount, scopeConcurrency, sweepCap,        // the scheduling facts, echoed as recorded
//   waveCount,          // sum of each pass's waves — DERIVED, so it cannot contradict the records
// }
// [LAW:one-source-of-truth] A pass's `waves` derives from the DISTINCT scopes that actually spawned
// in it — ceil(distinctScopes / scopeConcurrency) — never from the planned scopeCount: a pass the
// time budget cut short mid-wave ran fewer waves than the plan implies, and a retried attempt is a
// second record for the SAME scope, not a second slot in a wave. So waveCount reflects work that
// actually ran — a fully-refused pass contributes no group, a partially-refused one only the waves
// its spawned scopes filled — never work that was merely planned.
function describeSchedule({ scopeConcurrency, sweepCap, scopeCount, spawns }) {
  const scouts = [];
  const byPass = new Map();
  // [LAW:no-silent-failure] The dispatch is EXHAUSTIVE over the phase vocabulary this module owns:
  // a record with a phase this fold doesn't recognize would otherwise vanish from the breakdown —
  // the exact drift the shared constructor exists to make impossible — so it throws instead.
  for (const s of spawns) {
    if (s.phase === 'scout') {
      scouts.push({ outcome: s.outcome, ms: spanMs(s.usage && s.usage.span) });
    } else if (s.phase === 'worker') {
      if (!byPass.has(s.pass)) byPass.set(s.pass, []);
      byPass.get(s.pass).push({ scope: s.scope, outcome: s.outcome, ms: spanMs(s.usage && s.usage.span) });
    } else {
      throw new Error(`describeSchedule: unknown phase ${JSON.stringify(s.phase)} in spawn record`);
    }
  }
  const passes = [...byPass.keys()].sort((a, b) => a - b).map(pass => {
    const spawns = byPass.get(pass);
    const distinctScopes = new Set(spawns.map(s => s.scope)).size;
    return { pass, spawns, waves: Math.ceil(distinctScopes / scopeConcurrency) };
  });
  return {
    // scoutMs stays derived from the scout rows it sits beside, so the summary figure and the
    // per-attempt table can never disagree about the scout. [LAW:one-source-of-truth]
    scoutMs: sumMs(scouts.map(s => s.ms)),
    scouts,
    passes,
    scopeCount,
    scopeConcurrency,
    sweepCap,
    waveCount: passes.reduce((sum, p) => sum + p.waves, 0),
  };
}

// ---------------------------------------------------------------------------------------------
// RENDERING — the schedule as the footer line an operator reads. It lives here, beside the value
// it formats, exactly as renderCostLine lives beside the cost value in usage.js: one module owns
// "what the pass's time was" from record shape through derivation to the string a sink prints.
// [LAW:one-type-per-behavior] Every sink (PR footer, repo report, the local dev script) renders
// through this one formatter, so the breakdown cannot drift between them.

// [LAW:effects-at-boundaries] Pure: a millisecond count as the compact figure a footer line can
// afford — '2m08s', '45s', '1h02m08s'. null is a RECORDED absence and renders as the word for it,
// never as a fabricated '0s': an unclocked spawn did take time, we just cannot say how much.
// [LAW:no-silent-failure]
function formatMs(ms) {
  if (ms == null) return 'unclocked';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// [LAW:effects-at-boundaries] Pure: the live run log's running-total clause (zai-timing-31d.7) —
// wall clock spent so far, set against the budget the run was minted with. Both arguments are
// nullable ABSENCES with renderings, never fabricated zeros: an unknown start renders the elapsed
// as 'unclocked' (formatMs's word for time we cannot count), and a null budget renders '(no
// budget)' rather than inventing a bound. [LAW:dataflow-not-control-flow] one clause shape,
// selected by the values — the no-budget run logs through the same line, not around it.
function renderRunningTotal(elapsedMs, budgetMs) {
  const elapsed = `elapsed ${formatMs(elapsedMs)}`;
  return budgetMs == null ? `${elapsed} (no budget)` : `${elapsed} of ${formatMs(budgetMs)} budget`;
}

// [LAW:dataflow-not-control-flow] One clause shape for every phase, selected by the VALUES of its
// durations, not by branches that skip the phase: no records at all is 'missing' (the explicit gap
// the ticket demands for an absent phase), all-unclocked is 'unclocked', a partial clock renders
// as the sum marked '+' — the same lower-bound convention the cost tally already uses — and a full
// clock is the plain figure.
function phaseClause(label, durations) {
  if (durations.length === 0) return `${label} missing`;
  const sum = sumMs(durations);
  if (sum == null) return `${label} unclocked`;
  const partial = durations.some(d => d == null) ? '+' : '';
  return `${label} ${formatMs(sum)}${partial}`;
}

// pass 0 is the review of record; pass 1..N are convergence sweeps — the same vocabulary the run
// log's 'sweep N ' labels already use. [LAW:one-source-of-truth]
function passLabel(pass) {
  return pass === 0 ? 'review' : `sweep ${pass}`;
}

// [LAW:single-enforcer] The ONE escape for untrusted text this renderer interpolates — scope names,
// which are LLM-minted free strings (the scout's add_scope checks only the type). The rendering
// context is a markdown table cell inside a <details> block plus an inline clause, so three things
// must die: `|` and newlines (they ARE the table/line structure), markdown inline metacharacters
// (emphasis, links, code spans — backslash-escaped so the name displays literally), and `<>&`
// (entity-encoded — the block is HTML context). Deliberately local rather than imported from
// dependency-diff.js: its mdText serves a different rendering context, and this module stays
// dependency-free so every sink can import it. [LAW:one-way-deps]
function scopeText(str) {
  return String(str)
    .replace(/\s+/g, ' ')
    .replace(/[\\`*_[\]()~|]/g, m => `\\${m}`)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// [LAW:effects-at-boundaries] Pure: the timing breakdown as the markdown block the sinks print —
// one scannable summary line, then the per-attempt table folded behind <details> so it sits under
// a review a human reads for its FINDINGS without shouting over them.
//
// The line answers "why was this slow?" without the run log: total wall clock (the whole run —
// preflight, diff fetch and host I/O included, which is why it comes from the run's own clock and
// not from summing spawns); the spawn time inside it (their ratio separates working from waiting);
// the split by phase; the slowest scope (one pathological scope sets its wave's duration, and
// every wave waits for it); and the schedule sentence that turns spawn time into wall time.
//
// [LAW:parse-dont-validate] totalMs is minted by the run boundary from its one clock; a non-finite
// or negative figure here is a wiring bug, thrown loudly for the boundary's catch — never rendered
// as a nonsense total. schedule may be null — the recorded absence (e.g. a review produced without
// a pass envelope) — and renders as the explicit gap, never as a silently omitted line.
// [LAW:no-silent-failure]
function renderTimingBreakdown(schedule, totalMs) {
  if (!Number.isFinite(totalMs) || totalMs < 0) {
    throw new Error(`renderTimingBreakdown: totalMs must be a non-negative finite number (got ${JSON.stringify(totalMs)})`);
  }
  if (schedule == null) {
    return `_Timing: ${formatMs(totalMs)} total · spawn breakdown unavailable — this run recorded no schedule_`;
  }
  const d = describeSchedule(schedule);
  const workerRows = d.passes.flatMap(p => p.spawns.map(s => ({ pass: p.pass, ...s })));
  const allDurations = [...d.scouts.map(s => s.ms), ...workerRows.map(s => s.ms)];
  const spawnCount = allDurations.length;
  const phases = [
    phaseClause('scout', d.scouts.map(s => s.ms)),
    ...d.passes.map(p => phaseClause(passLabel(p.pass), p.spawns.map(s => s.ms))),
  ].join(' · ');
  // The slowest CLOCKED worker attempt; ties keep the first recorded. All-unclocked stays an
  // explicit 'unclocked', never a fabricated winner.
  const slowest = workerRows.reduce((best, s) => (s.ms != null && (best == null || s.ms > best.ms) ? s : best), null);
  const slowestClause = slowest ? `slowest scope: ${scopeText(slowest.scope)} (${formatMs(slowest.ms)})` : 'slowest scope: unclocked';
  const scheduleSentence =
    `${d.scopeCount} scope(s) at concurrency ${d.scopeConcurrency} over ${d.passes.length} pass(es) = ${d.waveCount} wave(s)`;
  const line = `_Timing: ${formatMs(totalMs)} total · ${phaseClause('spawns', allDurations)} (${spawnCount} attempt(s))`
    + ` — ${phases} · ${slowestClause} · ${scheduleSentence}_`;
  const rows = [
    ...d.scouts.map(s => `| scout | — | ${s.outcome} | ${formatMs(s.ms)} |`),
    ...workerRows.map(s => `| ${passLabel(s.pass)} | ${scopeText(s.scope)} | ${s.outcome} | ${formatMs(s.ms)} |`),
  ];
  const details = [
    '<details>',
    '<summary>Timing by scope</summary>',
    '',
    '| phase | scope | outcome | duration |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '</details>',
  ].join('\n');
  return `${line}\n\n${details}`;
}

module.exports = { spawnRecord, scheduleRecord, spanMs, sumMs, describeSchedule, formatMs, passLabel, renderRunningTotal, renderTimingBreakdown };
