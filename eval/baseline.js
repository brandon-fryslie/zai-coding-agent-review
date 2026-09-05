#!/usr/bin/env node
'use strict';
// Freeze a SUITE BASELINE from scored replay artifacts. Given every golden case's scorecard-summary.json
// (eval/out/<case>/scorecard-summary.json, produced by eval/score.js over N repeats), reduce the whole
// suite to one committed baseline.json + a human-readable baseline.md, tagged with the exact main SHA and
// engine that produced it. That frozen distribution is the reference the compare gate (2fk.5) measures a
// candidate against: "did this engine change degrade finding quality?" is answered relative to THIS band,
// never an assumed ceiling. [LAW:verifiable-goals]
//
// This is an INSTRUMENT, not a second scorer: it never re-runs the engine (run-case.js) and never re-scores
// (score.js). It only COLLECTS the per-case bands score.js already computed, adds provenance, derives the
// suite's pooled gate floor + each case's diagnostic floor + the suite cost, and freezes the result. [LAW:decomposition]
//
//   node eval/baseline.js [--out-dir eval/out] [--cases-dir eval/cases] [--dest eval/baseline]
//                         [--sha <git-sha>] [--date <YYYY-MM-DD>]
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib + the pure JSON-object boundary imported
// from score.js. Every world-effect (fs, git) lives inside main(), so importing this file for the
// pure-core tests performs no IO.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseJsonObject } = require('./score');

// The schema id the freezer stamps and the loader demands — one name, written once, so a writer that
// stamped a version the reader rejects is not expressible. Superseded schemas (the v1 baseline kept under
// eval/baseline/ as history) are identified by NOT being this. [LAW:one-source-of-truth]
const BASELINE_SCHEMA = 'copirate-eval-baseline/v2';

// [LAW:one-source-of-truth] THE degradation rule, defined once — evaluateGate applies it, the compare
// CLI (2fk.5) wraps it, README.md documents it, baseline.md renders it: one wording, several consumers.
// The gated metric is INVENTORY must-find recall — recall against each case's pooled multi-round finding
// inventory (every distinct defect any review round of the source PR surfaced that exists in the frozen
// material), so "one round finds what five rounds found together" is what the gate protects. For a case
// with no inventory rounds the inventory equals the frozen round, so this is a strict generalization of
// the earlier frozen-round gate (kept in the baseline as a continuity diagnostic).
// The rule is POOLED across runs, and that choice is forced by the observed variance, not a preference.
// Per-case must-find denominators are tiny, so a per-case recall MEAN is dominated by run-to-run jitter —
// in the 2026-08-01 baseline the spread exceeded the mean for 3 of 4 cases, and 3 floors sat at 0% (a
// candidate cannot score below 0, so a per-case floor rule is unfalsifiable there). Pooling every run's
// inventory must-find finds across all cases into ONE binomial rate (found / opportunities over N×cases
// runs) recovers a gateable signal with a real sampling margin. The per-case bands are kept as
// DIAGNOSTICS to localize a regression, never as independent gates.
const DEGRADATION_RULE = {
  metric: 'pooledInventoryMustFindRecall',
  comparator: 'lt',
  floorSource: 'suite.pooledInventoryMustFind.gateFloor',
  description:
    'PRIMARY GATE (pooled): the suite is DEGRADED when a candidate\'s pooled inventory must-find recall — ' +
    'total inventory must-finds found across all N×cases runs ÷ total inventory must-find opportunities, ' +
    'where a case\'s inventory pools every distinct must-find from all of its source PR\'s review rounds ' +
    'that exists in the frozen material — falls below this baseline\'s pooled gate floor (the baseline ' +
    'pooled rate minus a ~2σ binomial sampling margin). Pooling across runs is used because per-case ' +
    'recall means are too noisy to gate on at these tiny denominators. The frozen-round pooled rate and ' +
    'the per-case bands below are DIAGNOSTICS — they localize which case moved — not independent gates.',
};

// A ~2σ (z≈1.96) normal-approximation lower confidence bound on a binomial rate, clamped to [0,1]. It is
// the pooled gate floor: a candidate at the same true quality clears it with ~97.5% confidence, so dipping
// below it is evidence of real degradation, not sampling jitter. np and n(1−p) are both ≫5 at N=5 across
// four cases (found=14, opportunities=75), so the normal approximation is sound. [LAW:effects-at-boundaries] Pure.
const POOLED_FLOOR_Z = 1.96;
function pooledFloor(found, total) {
  if (total === 0) return null;
  const p = found / total;
  const se = Math.sqrt((p * (1 - p)) / total);
  return Math.max(0, p - POOLED_FLOOR_Z * se);
}

const USAGE = `Freeze a suite baseline from scored replay artifacts: collect every golden case's
scorecard-summary.json into one committed baseline.json + baseline.md, tagged with the main SHA + engine
that produced it. This is the reference distribution the compare gate (2fk.5) measures candidates against.

Usage: node eval/baseline.js [options]

  --out-dir <dir>    Where scored run artifacts live (default: eval/out). Each golden case must have a
                     scorecard-summary.json under <out-dir>/<case>/ — run eval/score.js first.
  --cases-dir <dir>  Where the frozen golden cases live (default: eval/cases). The golden set is enumerated
                     from here; a frozen case with no scored summary aborts (a partial baseline is never
                     silently completed). A scored dir under <out-dir> with no matching golden case is not
                     part of the suite and is ignored.
  --dest <dir>       Baseline output root (default: eval/baseline). Writes <dest>/<date>-<shortsha>/.
  --sha <git-sha>    The main commit this baseline characterizes (default: git rev-parse HEAD).
  --date <date>      YYYY-MM-DD stamp for the baseline dir (default: today, UTC).
  --help             Show this help.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing (pure) — mirrors run-case.js / score.js: `--flag value` and `--flag=value` both work;
// an unknown flag or a missing value aborts here, at the boundary. [LAW:parse-dont-validate]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { outDir: 'eval/out', casesDir: 'eval/cases', dest: 'eval/baseline', sha: null, date: null };
  const keyFor = { 'out-dir': 'outDir', 'cases-dir': 'casesDir', dest: 'dest', sha: 'sha', date: 'date' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg} (baseline.js takes only --flags). See --help.`);
    const eq = arg.indexOf('=');
    const rawName = arg.slice(2, eq === -1 ? undefined : eq);
    if (!(rawName in keyFor)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    // [LAW:no-silent-failure] A space-separated value that is itself a flag is a missing value, not a
    // literal argument — consuming it would swallow the next flag and drop the user's intent. An EMPTY
    // value (`--out-dir=` or `--out-dir ''`) is likewise rejected: left through, path.resolve('') silently
    // becomes cwd, writing the baseline into the wrong directory instead of failing loudly.
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new Error(`Option --${rawName} requires a non-empty value.`);
    opts[keyFor[rawName]] = value;
  }
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Input parsing (parse-dont-validate) — a scorecard-summary.json is only accepted once every band the
// baseline reads is proven present + well-shaped, so buildBaseline never re-checks. [LAW:no-silent-failure]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// A band is score.js's aggregateRuns shape: {mean,min,max,n}. mean/min/max are numbers OR null (a metric
// with no data — e.g. a bucket with zero expected findings, or cost unavailable); n is a non-negative int.
function parseBand(v, at) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${at} is not a band object {mean,min,max,n}.`);
  const numOrNull = (x, field) => {
    if (x === null) return null;
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${at}.${field} must be a finite number or null (got ${JSON.stringify(x)}).`);
    return x;
  };
  if (!Number.isInteger(v.n) || v.n < 0) throw new Error(`${at}.n must be a non-negative integer (got ${JSON.stringify(v.n)}).`);
  return { mean: numOrNull(v.mean, 'mean'), min: numOrNull(v.min, 'min'), max: numOrNull(v.max, 'max'), n: v.n };
}

// The per-case scorecard-summary.json (score.js's aggregateRuns output). Only the fields the baseline
// reduces are required. `runs` is the N this case was scored over; the bands are its variance. This is the
// BOUNDARY: each perRun's mustFind is parsed to a typed {found,total} here (via parseFraction, the single
// fraction enforcer), so buildBaseline consumes typed numbers and never re-parses or receives a null.
// [LAW:parse-dont-validate] [LAW:single-enforcer]
function parseCaseSummary(raw, label) {
  const json = parseJsonObject(raw, label);
  if (typeof json.case !== 'string' || json.case.trim() === '') throw new Error(`${label} has no 'case' name.`);
  if (!Number.isInteger(json.runs) || json.runs < 1) throw new Error(`${label} 'runs' must be a positive integer (got ${JSON.stringify(json.runs)}).`);
  if (typeof json.matcher !== 'string' || json.matcher.trim() === '') throw new Error(`${label} has no 'matcher'.`);
  if (!Array.isArray(json.perRun)) throw new Error(`${label} has no 'perRun' array.`);
  // [LAW:no-silent-failure] perRun IS the N runs; a length that disagrees with `runs` means the summary is
  // corrupt, and buildBaseline would pool only the shorter array — a silently wrong rate + gate floor.
  if (json.perRun.length !== json.runs) {
    throw new Error(`${label} has ${json.perRun.length} perRun entries but claims runs=${json.runs} — they must agree (the pooled rate sums perRun).`);
  }
  return {
    case: json.case,
    runs: json.runs,
    matcher: json.matcher,
    mustFindRecall: parseBand(json.mustFindRecall, `${label}.mustFindRecall`),
    inventoryMustFindRecall: parseBand(json.inventoryMustFindRecall, `${label}.inventoryMustFindRecall`),
    niceToFindRecall: parseBand(json.niceToFindRecall, `${label}.niceToFindRecall`),
    inventoryNiceToFindRecall: parseBand(json.inventoryNiceToFindRecall, `${label}.inventoryNiceToFindRecall`),
    noiseCount: parseBand(json.noiseCount, `${label}.noiseCount`),
    costUsd: parseBand(json.costUsd, `${label}.costUsd`),
    perRun: json.perRun.map((r, i) => {
      const at = `${label}.perRun[${i}]`;
      // mustFind + inventoryMustFind are the pooled numerator/denominator sources — parse each to a typed
      // {found,total} at the boundary so buildBaseline can't see an absent/non-string value (which would
      // coerce to "null" deep in the reduction).
      const fraction = (v, field) => {
        if (typeof v !== 'string') throw new Error(`${at}.${field} must be a 'found/total' string (got ${JSON.stringify(v)}).`);
        return parseFraction(v, `${at}.${field}`);
      };
      const mustFind = fraction(r.mustFind, 'mustFind');
      const inventoryMustFind = fraction(r.inventoryMustFind, 'inventoryMustFind');
      // The inventory is a superset of the frozen round by construction (score.js buckets one findings
      // array two ways); a summary that violates that is corrupt, not a legal input.
      if (inventoryMustFind.total < mustFind.total || inventoryMustFind.found < mustFind.found) {
        throw new Error(`${at}.inventoryMustFind (${inventoryMustFind.found}/${inventoryMustFind.total}) is smaller than mustFind (${mustFind.found}/${mustFind.total}) — the inventory pools a superset of the frozen round.`);
      }
      // perRun costs are summed for the suite total; each is a number or null (cost unavailable that run).
      const costUsd = r.costUsd ?? null;
      if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd))) {
        throw new Error(`${at}.costUsd must be a finite number or null (got ${JSON.stringify(r.costUsd)}).`);
      }
      return { mustFind, inventoryMustFind, niceToFind: r.niceToFind ?? null, noise: r.noise ?? null, costUsd };
    }),
  };
}

// The pinned engine from a case.json — the single source of truth for what ran (run-case.js refuses any
// replay whose resolved config drifts from this pin, so the pin IS the engine the scorecard reflects).
function parseCaseEngine(raw, label) {
  const json = parseJsonObject(raw, label);
  const e = json.engine;
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${label} has no 'engine' object.`);
  if (typeof e.provider !== 'string' || e.provider.trim() === '') throw new Error(`${label} engine.provider is missing.`);
  if (typeof e.model !== 'string' || e.model.trim() === '') throw new Error(`${label} engine.model is missing.`);
  return { provider: e.provider, model: e.model, reasoning: e.reasoning ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure reduction — the testable core.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Two engines are the same pin iff every field matches. A suite whose cases ran on different engines is not
// one baseline — its recall numbers aren't comparable — so buildBaseline refuses it. [LAW:no-silent-failure]
function sameEngine(a, b) {
  return a.provider === b.provider && a.model === b.model && (a.reasoning ?? null) === (b.reasoning ?? null);
}

function round(x, dp) {
  if (x === null || x === undefined) return null;
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// [LAW:parse-dont-validate] A per-run must-find count is score.js's "found/total" string (aggregateRuns
// renders `${found}/${total}`). Parse it back to a {found,total} the pooling can sum, rejecting anything
// that isn't that exact shape rather than silently contributing 0. [LAW:no-silent-failure] total===0 is
// legal (a case with no must-finds) and pools as 0/0 — it simply adds no opportunities.
function parseFraction(str, at) {
  const m = /^(\d+)\/(\d+)$/.exec(str);
  if (!m) throw new Error(`${at} is not a 'found/total' fraction (got ${JSON.stringify(str)}).`);
  const found = Number(m[1]);
  const total = Number(m[2]);
  if (found > total) throw new Error(`${at} has found > total (${found}/${total}).`);
  return { found, total };
}

// Reduce the per-case summaries + their engines + provenance into the frozen baseline object. PURE: no IO,
// no clock, no git — every input is a parameter, so the same inputs always freeze the identical baseline.
// [LAW:effects-at-boundaries] Aborts loudly on any inconsistency that would make the baseline meaningless:
// zero cases, mixed repeat counts, mixed matchers, or mixed engines. [LAW:no-silent-failure]
function buildBaseline({ cases, provenance }) {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error('buildBaseline: no scored cases — nothing to freeze. Run eval/run-case.js + eval/score.js first.');
  }
  // Derive N and the matcher from the data (not a flag that could lie): every case must share them, or the
  // suite mixes incomparable measurements. [LAW:one-source-of-truth]
  const repeats = cases[0].summary.runs;
  const matcher = cases[0].summary.matcher;
  const engine = cases[0].engine;
  for (const c of cases) {
    if (c.summary.runs !== repeats) throw new Error(`Case '${c.summary.case}' was scored over ${c.summary.runs} run(s) but '${cases[0].summary.case}' over ${repeats} — a baseline needs one common N. Re-run the odd case at N=${repeats}.`);
    if (c.summary.matcher !== matcher) throw new Error(`Case '${c.summary.case}' was scored with matcher '${c.summary.matcher}' but '${cases[0].summary.case}' with '${matcher}' — a baseline needs one matcher.`);
    if (!sameEngine(c.engine, engine)) throw new Error(`Case '${c.summary.case}' pins engine ${JSON.stringify(c.engine)} but '${cases[0].summary.case}' pins ${JSON.stringify(engine)} — a baseline needs one engine.`);
  }

  // One pass over every run of every case, summing the suite-level facts:
  //  - POOLED INVENTORY must-find: total inventory finds ÷ total inventory opportunities across all runs —
  //    the primary gate's numerator. A per-run "5/9" contributes 5 finds and 9 opportunities; N repeats ×
  //    the case count makes one large sample.
  //  - POOLED frozen-round must-find: the same reduction over the frozen-round fractions — the continuity
  //    diagnostic comparable with pre-inventory baselines.
  //  - COST: every run's cost. A full suite run = one repeat over all cases (there are `repeats` of them),
  //    so the per-full-run figure is what a single gate invocation of the same shape spends. Null
  //    (cost-unavailable) runs are excluded from the sum and counted, so the total is honest.
  let pooledFound = 0;
  let pooledTotal = 0;
  let pooledInvFound = 0;
  let pooledInvTotal = 0;
  let totalCostUsd = 0;
  let costedRuns = 0;
  let uncostedRuns = 0;
  for (const c of cases) {
    c.summary.perRun.forEach((r) => {
      // mustFind / inventoryMustFind are already the typed {found,total} parseCaseSummary produced at the boundary.
      pooledFound += r.mustFind.found;
      pooledTotal += r.mustFind.total;
      pooledInvFound += r.inventoryMustFind.found;
      pooledInvTotal += r.inventoryMustFind.total;
      if (r.costUsd === null) { uncostedRuns++; return; }
      totalCostUsd += r.costUsd;
      costedRuns++;
    });
  }
  // [LAW:one-source-of-truth] A suite with zero inventory must-find opportunities has no pooled rate and a
  // null gate floor — it cannot gate, and parseBaseline (the loader) requires opportunities>=1 + a finite
  // floor. Refuse it at the producer so every baseline buildBaseline emits is one parseBaseline can load
  // back. [LAW:no-silent-failure] (The inventory pool is a superset of the frozen-round pool — enforced at
  // parseCaseSummary — so this single check covers both.)
  if (pooledInvTotal === 0) {
    throw new Error('buildBaseline: the suite has zero inventory must-find opportunities — not a gradeable baseline (every case has an empty must-find set). Check the annotations.');
  }
  const pooledRate = pooledTotal === 0 ? null : pooledFound / pooledTotal;
  const pooledInvRate = pooledInvFound / pooledInvTotal;

  const caseEntries = cases.map(c => ({
    case: c.summary.case,
    mustFindRecall: c.summary.mustFindRecall,
    inventoryMustFindRecall: c.summary.inventoryMustFindRecall,
    niceToFindRecall: c.summary.niceToFindRecall,
    inventoryNiceToFindRecall: c.summary.inventoryNiceToFindRecall,
    noiseCount: c.summary.noiseCount,
    costUsd: c.summary.costUsd,
    // DIAGNOSTIC floor — this case's observed worst inventory must-find recall (min). NOT a gate on its own
    // (per-case means are too noisy at these denominators; see DEGRADATION_RULE). It localizes which case
    // moved when the pooled gate trips. null only if the case has zero must-finds (band n===0), which the
    // annotator should never produce — surfaced, not hidden.
    diagnosticFloor: c.summary.inventoryMustFindRecall.min,
    // Reconstruct the "found/total" display strings from the typed values (identical to what score.js rendered).
    perRun: c.summary.perRun.map(r => `${r.mustFind.found}/${r.mustFind.total}`),
    perRunInventory: c.summary.perRun.map(r => `${r.inventoryMustFind.found}/${r.inventoryMustFind.total}`),
  }));

  // Suite headline: the unweighted mean of the per-case mean INVENTORY recalls — the same axis the gate
  // measures. Informational only — a summary of the cases, not the gate (cases have different
  // denominators, so their means don't pool by averaging).
  const caseMeans = caseEntries.map(c => c.inventoryMustFindRecall.mean).filter(v => v !== null);
  const suiteMeanRecall = caseMeans.length ? caseMeans.reduce((a, b) => a + b, 0) / caseMeans.length : null;

  return {
    schema: BASELINE_SCHEMA,
    generatedAt: provenance.date,
    mainSha: provenance.sha,
    engine,
    matcher,
    repeats,
    degradationRule: DEGRADATION_RULE,
    suite: {
      cases: caseEntries.length,
      // THE PRIMARY GATE number: pooled INVENTORY must-find recall + its ~2σ lower-bound floor. A candidate
      // whose pooled inventory recall (same suite, same N) falls below gateFloor is degraded. [LAW:one-source-of-truth]
      pooledInventoryMustFind: {
        found: pooledInvFound,
        opportunities: pooledInvTotal,
        rate: round(pooledInvRate, 4),
        gateFloor: round(pooledFloor(pooledInvFound, pooledInvTotal), 4),
      },
      // Continuity DIAGNOSTIC: the same reduction over the frozen-round fractions only — comparable with
      // pre-inventory (v1) baselines, never a gate.
      pooledMustFind: {
        found: pooledFound,
        opportunities: pooledTotal,
        rate: round(pooledRate, 4),
        gateFloor: round(pooledFloor(pooledFound, pooledTotal), 4),
      },
      meanInventoryMustFindRecall: round(suiteMeanRecall, 4),
      totalCostUsd: round(totalCostUsd, 4),
      // Per full suite run = totalCostUsd / repeats — but ONLY well-defined when every run is costed. With
      // any uncosted run, totalCostUsd is a partial sum while `repeats` still counts all full runs, so the
      // quotient underestimates; there is no correct single divisor. Emit null rather than a misleadingly
      // precise number — costedRuns/uncostedRuns disclose what's known. [LAW:no-silent-failure]
      costPerFullRunUsd: uncostedRuns === 0 ? round(totalCostUsd / repeats, 4) : null,
      costedRuns,
      uncostedRuns,
    },
    cases: caseEntries,
  };
}

// [LAW:parse-dont-validate] The loader the compare gate (2fk.5) reuses: a frozen baseline.json is only
// accepted once its schema, the pooled gate floor (the number the gate actually compares against), and each
// per-case diagnostic band are proven, so the gate never re-checks. This is deliberately a LOSSY GATE
// SUBSET, not a full round-trip of buildBaseline's output — it returns only what the gate consumes (pooled
// floor + per-case id/band), NOT the display fields (perRun/noiseCount/costUsd/suite cost). Widening it to
// carry those would validate surface no consumer needs. [LAW:carrying-cost] Consequently its output is not
// a valid input to renderBaselineMarkdown (which needs the rich freeze object); a committed baseline is
// re-read from baseline.md, never re-rendered from a loaded value.
function parseBaseline(raw, label) {
  const json = parseJsonObject(raw, label);
  if (json.schema !== BASELINE_SCHEMA) throw new Error(`${label} is not a v2 baseline (schema=${JSON.stringify(json.schema)}). Re-freeze it with eval/baseline.js.`);
  if (typeof json.mainSha !== 'string' || json.mainSha.trim() === '') throw new Error(`${label} has no 'mainSha'.`);
  if (!Number.isInteger(json.repeats) || json.repeats < 1) throw new Error(`${label} 'repeats' must be a positive integer.`);
  if (typeof json.suite !== 'object' || json.suite === null) throw new Error(`${label} has no 'suite'.`);
  const pooled = json.suite.pooledInventoryMustFind;
  if (typeof pooled !== 'object' || pooled === null) throw new Error(`${label} has no 'suite.pooledInventoryMustFind' (the primary gate number).`);
  if (!Number.isInteger(pooled.found) || !Number.isInteger(pooled.opportunities) || pooled.opportunities < 1) {
    throw new Error(`${label}.suite.pooledInventoryMustFind needs integer found + positive opportunities (got ${JSON.stringify(pooled)}).`);
  }
  if (typeof pooled.gateFloor !== 'number' || !Number.isFinite(pooled.gateFloor)) throw new Error(`${label}.suite.pooledInventoryMustFind.gateFloor must be a finite number.`);
  if (!Array.isArray(json.cases) || json.cases.length === 0) throw new Error(`${label} has no 'cases'.`);
  const cases = json.cases.map((c, i) => {
    const at = `${label}.cases[${i}]`;
    if (typeof c.case !== 'string' || c.case.trim() === '') throw new Error(`${at} has no 'case' name.`);
    if (c.diagnosticFloor !== null && (typeof c.diagnosticFloor !== 'number' || !Number.isFinite(c.diagnosticFloor))) {
      throw new Error(`${at}.diagnosticFloor must be a finite number or null (got ${JSON.stringify(c.diagnosticFloor)}).`);
    }
    return { case: c.case, diagnosticFloor: c.diagnosticFloor, inventoryMustFindRecall: parseBand(c.inventoryMustFindRecall, `${at}.inventoryMustFindRecall`) };
  });
  return {
    schema: json.schema, mainSha: json.mainSha, generatedAt: json.generatedAt ?? null,
    engine: json.engine ?? null, matcher: json.matcher ?? null, repeats: json.repeats,
    degradationRule: json.degradationRule ?? null,
    pooledInventoryMustFind: { found: pooled.found, opportunities: pooled.opportunities, rate: pooled.rate ?? null, gateFloor: pooled.gateFloor },
    cases,
  };
}

// [LAW:single-enforcer] THE gate predicate — the one place DEGRADATION_RULE is applied to a candidate.
// The compare CLI (2fk.5) wraps this; nothing else re-implements the comparison. PURE: baseline is
// parseBaseline's typed value, candidate is the candidate suite's pooled inventory must-find counts
// (found/opportunities across all its N×cases runs), and the verdict is a value. A candidate rate below
// the frozen gate floor is degradation beyond ~2σ sampling jitter. [LAW:effects-at-boundaries]
function evaluateGate(baseline, candidate) {
  if (!Number.isInteger(candidate.found) || !Number.isInteger(candidate.opportunities) || candidate.opportunities < 1) {
    throw new Error(`evaluateGate: candidate needs integer found + positive opportunities (got ${JSON.stringify(candidate)}).`);
  }
  if (candidate.found > candidate.opportunities) {
    throw new Error(`evaluateGate: candidate found > opportunities (${candidate.found}/${candidate.opportunities}).`);
  }
  const rate = candidate.found / candidate.opportunities;
  const gateFloor = baseline.pooledInventoryMustFind.gateFloor;
  return { degraded: rate < gateFloor, candidateRate: rate, gateFloor };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Human-readable rendering (pure).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Renders the RICH freeze-time baseline — buildBaseline's output, with the full suite cost + per-case
// perRun/noiseCount/costUsd. NOT parseBaseline's gate subset (which omits those); pairing them is a
// category error, not a supported composition. main() calls this once, at freeze time, on fresh
// buildBaseline output. [LAW:comments-carry-meaning]
function renderBaselineMarkdown(baseline) {
  const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const usd = (v) => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(4)}`);
  const eng = baseline.engine;
  const pooled = baseline.suite.pooledInventoryMustFind;
  const frozenPooled = baseline.suite.pooledMustFind;
  const lines = [
    `# Eval baseline — ${baseline.mainSha.slice(0, 7)} (${baseline.generatedAt})`,
    '',
    `Frozen distribution of must-find recall for the golden case suite on \`main\` at commit \`${baseline.mainSha}\`.`,
    `This is the reference the compare gate (\`copirate-eval-harness-2fk.5\`) measures a candidate engine change against.`,
    '',
    `- **Engine (pinned):** \`${eng.provider}\` / \`${eng.model}\`${eng.reasoning ? ` / reasoning=${eng.reasoning}` : ''}`,
    `- **Matcher:** \`${baseline.matcher}\``,
    `- **Repeats (N):** ${baseline.repeats} per case`,
    `- **PRIMARY GATE — pooled inventory must-find recall:** ${pct(pooled.rate)} (${pooled.found}/${pooled.opportunities} across all ${baseline.repeats}×${baseline.suite.cases} runs, against each case's pooled multi-round inventory); gate floor **${pct(pooled.gateFloor)}** (~2σ lower bound). A candidate below the floor is degraded.`,
    `- **Frozen-round pooled must-find recall:** ${pct(frozenPooled.rate)} (${frozenPooled.found}/${frozenPooled.opportunities}) — continuity diagnostic, comparable with pre-inventory baselines; not a gate.`,
    `- **Suite mean of per-case inventory recall means:** ${pct(baseline.suite.meanInventoryMustFindRecall)} (informational — the gate is the pooled inventory rate above, not this average)`,
    `- **Cost:** ${usd(baseline.suite.totalCostUsd)} total across ${baseline.suite.costedRuns} costed run(s)` +
      `${baseline.suite.uncostedRuns ? ` (+${baseline.suite.uncostedRuns} run(s) with no cost reported)` : ''}` +
      `, ≈ ${usd(baseline.suite.costPerFullRunUsd)} per full suite run (all cases once).`,
    '',
    '## Per-case must-find recall band (diagnostic)',
    '',
    'These bands localize *which* case moves a pooled regression; they are not independent gates (per-case means are too noisy at these denominators — see the rule). "inventory" spans every review round of the source PR; "frozen" is the single frozen round.',
    '',
    '| case | inventory recall (mean / min / max) | diag. floor | per-run inventory | frozen recall (mean) | per-run frozen | noise (mean) | cost/run (est.) |',
    '|------|-------------------------------------|-------------|-------------------|----------------------|----------------|--------------|-----------------|',
  ];
  for (const c of baseline.cases) {
    const inv = c.inventoryMustFindRecall;
    const mf = c.mustFindRecall;
    lines.push(
      `| \`${c.case}\` | ${pct(inv.mean)} / ${pct(inv.min)} / ${pct(inv.max)} | ${pct(c.diagnosticFloor)} | ${c.perRunInventory.join(' · ')} | ${pct(mf.mean)} | ${c.perRun.join(' · ')} | ${c.noiseCount.mean === null ? 'n/a' : c.noiseCount.mean.toFixed(1)} | ${usd(c.costUsd.mean)} |`,
    );
  }
  lines.push('');
  lines.push('## Degradation rule');
  lines.push('');
  lines.push(baseline.degradationRule.description);
  lines.push('');
  lines.push(`Mechanically: \`candidate.suite.pooledInventoryMustFind.rate < ${pct(pooled.gateFloor)}\` (this baseline's \`suite.pooledInventoryMustFind.gateFloor\`) ⇒ the suite is DEGRADED.`);
  lines.push('');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// main (effects) — collect the scored summaries + case engines from disk, resolve provenance, freeze.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Enumerate the golden case set from cases-dir: every subdir with a case.json. The case set is the frozen
// ground truth, so the baseline must cover exactly it — a golden case with no scored summary aborts (main),
// so a partial baseline never masquerades as complete. A scored dir with no matching golden case is not part
// of the suite and is ignored, never enumerated here. [LAW:no-silent-failure]
function findGoldenCases(casesDir) {
  if (!fs.existsSync(casesDir)) throw new Error(`Cases dir not found: ${casesDir}.`);
  const names = fs.readdirSync(casesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(casesDir, e.name, 'case.json')))
    .map(e => e.name)
    .sort();
  if (names.length === 0) throw new Error(`No frozen cases (dirs with case.json) under ${casesDir}.`);
  return names;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const casesDir = path.resolve(opts.casesDir);
  const outDir = path.resolve(opts.outDir);
  const caseNames = findGoldenCases(casesDir);

  const cases = caseNames.map(name => {
    const summaryPath = path.join(outDir, name, 'scorecard-summary.json');
    if (!fs.existsSync(summaryPath)) {
      throw new Error(`Case '${name}' is frozen but has no scored summary at ${summaryPath}. Run eval/run-case.js then eval/score.js for it before freezing the baseline.`);
    }
    const summary = parseCaseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
    if (summary.case !== name) throw new Error(`${summaryPath} names case '${summary.case}' but lives under '${name}'.`);
    const engine = parseCaseEngine(fs.readFileSync(path.join(casesDir, name, 'case.json'), 'utf8'), path.join(casesDir, name, 'case.json'));
    return { summary, engine };
  });

  // Provenance: the exact main SHA + a date stamp. SHA defaults to git HEAD (the commit this characterizes);
  // date defaults to today (UTC). [LAW:effects-at-boundaries] The git read is the only ambient input, done
  // here at the boundary, never inside buildBaseline.
  const sha = opts.sha || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname }).toString().trim();
  const date = opts.date || new Date().toISOString().slice(0, 10);

  const baseline = buildBaseline({ cases, provenance: { sha, date } });

  const destDir = path.join(path.resolve(opts.dest), `${date}-${sha.slice(0, 7)}`);
  fs.mkdirSync(destDir, { recursive: true });
  const jsonPath = path.join(destDir, 'baseline.json');
  const mdPath = path.join(destDir, 'baseline.md');
  fs.writeFileSync(jsonPath, JSON.stringify(baseline, null, 2) + '\n');
  fs.writeFileSync(mdPath, renderBaselineMarkdown(baseline));

  process.stdout.write(renderBaselineMarkdown(baseline));
  process.stdout.write(`\nFroze baseline (${baseline.cases.length} case(s), N=${baseline.repeats}) → ${destDir}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`baseline: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs, parseBand, parseCaseSummary, parseCaseEngine, parseFraction,
  sameEngine, pooledFloor, buildBaseline, parseBaseline, evaluateGate, renderBaselineMarkdown,
  DEGRADATION_RULE, BASELINE_SCHEMA,
};
