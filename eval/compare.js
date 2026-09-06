#!/usr/bin/env node
'use strict';
// THE QUALITY GATE (copirate-eval-harness-2fk.5). One command that answers the epic's question — "did my
// change degrade finding quality?" — with a measured verdict, so a quality-sensitive change (the efficiency
// epic's prompt restructuring, scout removal, tier lowering: copirate-efficiency-235.2/.3/.4/.5) ships only
// when the golden must-finds are still found.
//
//   node eval/compare.js [--baseline <dir|baseline.json>] [--matcher llm|lexical] [--out <dir>] ...
//
// A CANDIDATE IS JUST ANOTHER SUITE. This file does NOT reimplement pooling or scoring. It:
//   1. replays every golden case N times against the WORKING TREE's src/ (spawning eval/run-case.js — the
//      replay runner already drives src/ directly, so "the candidate" is simply the code as checked out;
//      no build or publish),
//   2. scores each case (spawning eval/score.js),
//   3. reduces the candidate's scored summaries into a suite with the SAME buildBaseline the frozen baseline
//      was built with (so producer and comparator can NEVER drift — [LAW:one-source-of-truth]), and
//   4. applies the frozen pooled degradation rule via baseline.js's evaluateGate: candidate pooled
//      inventory must-find recall < the baseline's pooled gate floor  ⇒  DEGRADED (non-zero exit).
// N and the engine are DERIVED FROM the baseline and asserted, because a candidate run at a different N or
// engine is not comparable — its pooled rate measures a different thing. [LAW:no-silent-failure]
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib + the pure reducers imported from baseline.js
// (buildBaseline/parseBaseline/…). Every world-effect (fs, git, spawning the run/score CLIs) lives inside
// main(), so importing this file for the pure-core tests performs no IO and spawns no subprocess.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const {
  parseCaseSummary, parseCaseEngine, buildBaseline, parseBaseline, sameEngine, evaluateGate,
} = require('./baseline');
const { matcherLabel, parseExpected, requireLlmJudgeCredential } = require('./score');

const USAGE = `Gate a candidate (the current working tree) against a frozen eval baseline: replay the golden
suite N times, score it, and print a DEGRADED / OK / IMPROVED verdict. Non-zero exit on DEGRADED.

Usage: ANTHROPIC_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… node eval/compare.js [options]

  --baseline <path>      Frozen baseline dir (or its baseline.json) to gate against. Default: the newest
                         committed baseline under eval/baseline/, by commit-graph order — NOT directory-name
                         order, and an uncommitted baseline.json always outranks a committed one. Refused
                         (exit 2) if the newest can't be determined unambiguously (e.g. a shallow git clone
                         with more than one candidate); pass --baseline explicitly in that case. N, engine,
                         and matcher come FROM whichever baseline is resolved.
  --matcher <kind>       Semantic matcher for scoring the candidate: 'llm' (default) or 'lexical'. MUST
                         match the baseline's matcher, or the recall numbers aren't comparable — refused
                         up front, before any spend. IGNORED under --reuse-candidate (no scoring runs in
                         that mode; the reused summaries' own recorded matcher is what's checked instead).
  --out <dir>            Candidate artifact root (default: eval/out/candidate-<ts>, git-ignored). Kept
                         isolated from the baseline's own run artifacts under eval/out/<case>/. Mutually
                         exclusive with --reuse-candidate (refused if both are passed). If it names an
                         existing root with prior run artifacts for a baseline case, refused rather than
                         silently blending old and new runs into one summary.
  --workers <N>          Max concurrent scope workers per replay (default: 4), forwarded to run-case.js.
  --cases-dir <dir>      Where the frozen golden cases live (default: eval/cases).
  --cache <file>         Judge-decision cache, forwarded to score.js (default: eval/out/.judge-cache.json).
  --reuse-candidate <d>  Skip the replay+score entirely and gate an ALREADY-produced candidate root <d>
                         (one <case>/scorecard-summary.json per baseline case). For re-rendering a verdict
                         or validating the gate without re-spending. Mutually exclusive with --out.
  --help                 Show this help.

The candidate always runs at the baseline's N and pinned engine (a replay at a different N/engine would
measure something else). Estimated cost is printed up front. Reads the provider credential from the same
env var the action uses (CLAUDE_CODE_OAUTH_TOKEN / DEEPSEEK_API_KEY / ZAI_API_KEY / OPENAI_API_KEY), per the
case's pinned provider — PLUS, unconditionally, ANTHROPIC_API_KEY for the default '--matcher llm' judge,
regardless of which provider the pinned engine itself uses (pass --matcher lexical to avoid this second
credential). The judge is deliberately a separate credential from the engine's: it is the ruler, and a
ruler that moved with the thing it measures would measure nothing.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing (pure) — mirrors run-case.js / score.js / baseline.js: `--flag value` and `--flag=value`
// both work; an unknown flag, a missing value, or an empty value aborts here, at the boundary, so nothing
// downstream re-checks. [LAW:parse-dont-validate] [LAW:no-silent-failure]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    baseline: null, matcher: 'llm', out: null, workers: 4,
    casesDir: 'eval/cases', cache: 'eval/out/.judge-cache.json', reuseCandidate: null,
  };
  const keyFor = {
    baseline: 'baseline', matcher: 'matcher', out: 'out', workers: 'workers',
    'cases-dir': 'casesDir', cache: 'cache', 'reuse-candidate': 'reuseCandidate',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg} (compare.js takes only --flags). See --help.`);
    const eq = arg.indexOf('=');
    const rawName = arg.slice(2, eq === -1 ? undefined : eq);
    if (!(rawName in keyFor)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    // A space-separated value that is itself a flag is a missing value, not a literal argument — consuming
    // it would swallow the next flag. An empty value is likewise rejected before it resolves to cwd.
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new Error(`Option --${rawName} requires a non-empty value.`);
    opts[keyFor[rawName]] = value;
  }
  if (opts.matcher !== 'llm' && opts.matcher !== 'lexical') throw new Error(`--matcher must be 'llm' or 'lexical' (got ${JSON.stringify(opts.matcher)}).`);
  opts.workers = parsePositiveInt(opts.workers, '--workers');
  return opts;
}

// [LAW:parse-dont-validate] Positive-integer flag — Number() + Number.isInteger rejects '2.5'/'abc' where
// parseInt would silently truncate. The rejected value is echoed so a typo is located, not guessed.
function parsePositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw)}).`);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure comparison core — the testable gate. No IO, no clock, no spawn.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// The exact matcher label score.js records for a given --matcher kind — an alias of score.js's OWN
// matcherLabel (the single producer of the format, which its main() also calls), kept under this file's
// established name so a matcher mismatch against the baseline can be refused BEFORE a full suite run.
// [LAW:one-source-of-truth]
const expectedMatcherLabel = matcherLabel;

// The candidate's estimated cost for one gate invocation: one full suite run per repeat. Uses the
// baseline's own recorded per-full-run cost × N (2fk.4's numbers), so the guardrail is printed BEFORE
// spending. Null when the baseline never recorded a costed per-run figure (nothing to estimate from).
function estimateCandidateCostUsd(rawBaselineSuite, repeats) {
  const perRun = rawBaselineSuite && rawBaselineSuite.costPerFullRunUsd;
  if (typeof perRun !== 'number' || !Number.isFinite(perRun)) return null;
  return perRun * repeats;
}

// The total pooled inventory must-find opportunities a candidate suite would report, given each baseline
// case's CURRENT must-find count (any round) from its expected.json and the repeat count — the same
// quantity buildBaseline sums from real scored runs, computed here without spending on any of them.
// Extracted as a pure function (fed a plain case→count map, not the fs reads that produce it) so the
// arithmetic — the actual risk in this check (an off-by-one, a wrong multiply) — is unit-testable without
// fixtures on disk. [LAW:effects-at-boundaries]
function computeExpectedOpportunities(mustFindCountsByCase, repeats) {
  return repeats * Object.values(mustFindCountsByCase).reduce((sum, n) => sum + n, 0);
}

// Compare a candidate SUITE (buildBaseline output over the candidate's scored summaries) against a frozen
// baseline (parseBaseline output). PURE: same inputs → same verdict, so the gate is unit-testable without
// spending a run. Aborts loudly on any incomparability — a mismatched N, engine, matcher, or case set makes
// the pooled rates measure different things, so a verdict over them would be a silent lie. [LAW:no-silent-failure]
function compareVerdict(baseline, candidate) {
  if (candidate.repeats !== baseline.repeats) {
    throw new Error(`Incomparable: candidate ran at N=${candidate.repeats} but the baseline is N=${baseline.repeats}. The candidate must replay at the baseline's N — the pooled rate depends on it.`);
  }
  // The baseline's engine/matcher are the pins the candidate must have run under. A pre-v1 baseline could
  // carry a null engine; only assert when the baseline actually pins one.
  if (baseline.engine && !sameEngine(candidate.engine, baseline.engine)) {
    throw new Error(`Incomparable: candidate ran on engine ${JSON.stringify(candidate.engine)} but the baseline pins ${JSON.stringify(baseline.engine)}.`);
  }
  if (baseline.matcher && candidate.matcher !== baseline.matcher) {
    throw new Error(`Incomparable: candidate was scored with matcher '${candidate.matcher}' but the baseline used '${baseline.matcher}'. Recall from two matchers isn't comparable.`);
  }
  // Same case SET — the pooled denominator must be over exactly the baseline's suite, or the rates measure
  // different populations. Order-independent; names are unique per suite (uniqueness comes from
  // findGoldenCases's directory enumeration upstream in baseline.js's main(), not from buildBaseline
  // itself). A candidate missing a baseline case, or carrying one the baseline never froze, is refused.
  const baseNames = baseline.cases.map(c => c.case).sort();
  const candNames = candidate.cases.map(c => c.case).sort();
  if (baseNames.length !== candNames.length || baseNames.some((n, i) => n !== candNames[i])) {
    const missing = baseNames.filter(n => !candNames.includes(n));
    const extra = candNames.filter(n => !baseNames.includes(n));
    throw new Error(`Incomparable case sets: ${missing.length ? `candidate is missing [${missing.join(', ')}]` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `candidate has extra [${extra.join(', ')}]` : ''}. The gate pools over the baseline's exact suite.`);
  }
  // Same pooled DENOMINATOR — expected.json is a living document (README: "The pooled inventory, and its
  // eligibility rule"): inventory findings get curated into it over time, independent of re-freezing the
  // baseline. If a case's expected.json gains or loses a must-find entry after the baseline was frozen, the
  // candidate is scored against a different opportunity count than the gate floor was computed from — an
  // apples-to-oranges comparison this file otherwise goes out of its way to refuse. This is a SUITE-total
  // check, not a full per-case one (that would need parseBaseline to carry each case's raw opportunities,
  // which its deliberately lossy gate subset does not — [LAW:carrying-cost]); it catches the realistic case
  // (a case's inventory changed) but not a contrived net-zero add/remove across cases. [LAW:no-silent-failure]
  if (candidate.suite.pooledInventoryMustFind.opportunities !== baseline.pooledInventoryMustFind.opportunities) {
    throw new Error(`Incomparable: candidate's pooled inventory opportunities (${candidate.suite.pooledInventoryMustFind.opportunities}) differ from the baseline's (${baseline.pooledInventoryMustFind.opportunities}) — expected.json likely changed since the baseline was frozen. Re-freeze the baseline before gating against this expected.json.`);
  }

  // THE GATE — delegated to evaluateGate (baseline.js), the single place DEGRADATION_RULE is applied to a
  // candidate. [LAW:single-enforcer] This file must never re-derive degraded from raw rate/floor numbers.
  const candidatePooled = candidate.suite.pooledInventoryMustFind;
  const baselinePooled = baseline.pooledInventoryMustFind;
  const gate = evaluateGate(baseline, candidatePooled);
  const { degraded, gateFloor } = gate;
  // IMPROVED / OK are informational labels only (never the gate): the pooled point estimate rising above the
  // baseline's is suggestive, not significant at this denominator. Only DEGRADED reds the run.
  const status = degraded ? 'DEGRADED' : (baselinePooled.rate !== null && candidatePooled.rate > baselinePooled.rate ? 'IMPROVED' : 'OK');

  // Per-case localization — for each baseline case, its inventory diagnostic band vs the candidate's. `moved`
  // flags a case whose candidate MEAN recall dipped below the baseline's own observed worst run (its
  // diagnostic floor): the localizer for "which case moved the pooled rate". Diagnostics only — never a gate.
  const candByName = new Map(candidate.cases.map(c => [c.case, c]));
  const cases = baseline.cases.map((b) => {
    const c = candByName.get(b.case);
    const candBand = c.inventoryMustFindRecall;
    const delta = (candBand.mean !== null && b.inventoryMustFindRecall.mean !== null) ? candBand.mean - b.inventoryMustFindRecall.mean : null;
    const moved = (b.diagnosticFloor !== null && candBand.mean !== null && candBand.mean < b.diagnosticFloor);
    return {
      case: b.case,
      baselineBand: b.inventoryMustFindRecall,
      baselineDiagnosticFloor: b.diagnosticFloor,
      candidateBand: candBand,
      candidateDiagnosticFloor: c.diagnosticFloor,
      delta,
      moved,
    };
  });

  return {
    status,
    degraded,
    repeats: baseline.repeats,
    engine: baseline.engine,
    matcher: baseline.matcher,
    pooled: {
      candidate: candidatePooled,
      baseline: baselinePooled,
      gateFloor,
    },
    movedCases: cases.filter(c => c.moved).map(c => c.case),
    cases,
  };
}

// Null-safe percent formatting — module scope so both the Markdown renderer and main()'s plain-text log
// line share ONE formatter. parseBaseline allows a pooled `rate` to be null (a hand-edited or otherwise
// non-buildBaseline-produced baseline.json), unlike gateFloor, which it requires; a bare `.toFixed(0)`
// on that field would coerce null to 0 and print a misleading "0%" instead of surfacing the gap.
// [LAW:one-source-of-truth]
function pct(v) {
  return v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(0)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Rendering (pure). ONE renderer — Markdown — because the verdict table is meant to be pasted into a PR
// body (this ticket) and rendered into a GitHub Step Summary (2fk.6), and it reads fine in a terminal too.
// No plain/markdown split. [LAW:no-mode-explosion]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function renderVerdictMarkdown(verdict, meta = {}) {
  const usd = (v) => (v === null || v === undefined ? 'n/a' : `$${v.toFixed(4)}`);
  const signedPct = (v) => (v === null || v === undefined ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(0)}%`);
  const p = verdict.pooled;
  const eng = verdict.engine;
  const badge = { DEGRADED: '🔴 DEGRADED', OK: '🟢 OK', IMPROVED: '🟢 IMPROVED' }[verdict.status] || verdict.status;

  const lines = [
    `## Eval verdict — ${badge}`,
    '',
    `Candidate${meta.candidateSha ? ` (working tree \`${meta.candidateSha}\`${meta.dirty ? ', dirty' : ''})` : ''} vs baseline` +
      `${meta.baselineSha ? ` \`${meta.baselineSha.slice(0, 7)}\`` : ''}` +
      `${eng ? ` · engine \`${eng.provider}\`/\`${eng.model}\`${eng.reasoning ? `/reasoning=${eng.reasoning}` : ''}` : ''}` +
      ` · N=${verdict.repeats}${verdict.matcher ? ` · matcher \`${verdict.matcher}\`` : ''}.`,
    '',
    `**PRIMARY GATE — pooled inventory must-find recall:** candidate **${pct(p.candidate.rate)}** ` +
      `(${p.candidate.found}/${p.candidate.opportunities}) vs gate floor **${pct(p.gateFloor)}** ` +
      `(baseline ${pct(p.baseline.rate)}, ${p.baseline.found}/${p.baseline.opportunities}) → ` +
      `${verdict.degraded ? '**below floor**' : 'at/above floor'}.`,
    '',
    '| case | baseline recall (mean [min–max]) | candidate recall (mean [min–max]) | Δ mean | moved? |',
    '|------|----------------------------------|-----------------------------------|--------|--------|',
  ];
  for (const c of verdict.cases) {
    const b = c.baselineBand;
    const cd = c.candidateBand;
    lines.push(
      `| \`${c.case}\` | ${pct(b.mean)} [${pct(b.min)}–${pct(b.max)}] | ${pct(cd.mean)} [${pct(cd.min)}–${pct(cd.max)}] | ${signedPct(c.delta)} | ${c.moved ? '⚠️ yes' : 'no'} |`,
    );
  }
  lines.push('');
  if (meta.cost) {
    lines.push(
      `**Cost:** baseline ≈ ${usd(meta.cost.baselinePerRun)}/full-run vs candidate ≈ ${usd(meta.cost.candidatePerRun)}/full-run` +
      `${meta.cost.delta === null ? '' : ` (Δ ${meta.cost.delta >= 0 ? '+' : ''}${usd(meta.cost.delta)})`}.`,
    );
    lines.push('');
  }

  // The final one-line verdict — the sentence a reader (or 2fk.6's Step Summary) reads first.
  if (verdict.degraded) {
    const named = verdict.movedCases.length
      ? `Localized to: ${verdict.movedCases.map(n => `\`${n}\``).join(', ')} (candidate mean below the case's diagnostic floor).`
      : `No single case crossed its diagnostic floor — the pooled recall fell broadly, not in one case.`;
    lines.push(`**VERDICT: DEGRADED** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} is below the ${pct(p.gateFloor)} gate floor. ${named}`);
  } else if (verdict.status === 'IMPROVED') {
    lines.push(`**VERDICT: OK (improved)** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} clears the ${pct(p.gateFloor)} floor and exceeds the baseline ${pct(p.baseline.rate)}. (Point estimate only — not significant at this denominator.)`);
  } else {
    lines.push(`**VERDICT: OK** — candidate pooled inventory must-find recall ${pct(p.candidate.rate)} clears the ${pct(p.gateFloor)} gate floor. Finding quality is not degraded.`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Effects (main) — resolve the baseline, spawn the replay+score CLIs, reduce, compare, exit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Every commit SHA in `gitCwd`'s history, git's own default order (newest first) — the commit GRAPH's
// parent→child order, not a timestamp. Two baselines frozen back to back land in the SAME second (%cI is
// second-granularity), so comparing ISO timestamp strings ties exactly the pair this tie-break exists to
// distinguish; the commit graph never ties, because a child's parent pointer fixes its position regardless
// of clock resolution. Empty (not a repo, no commits, git unavailable) is a legitimate value, not an error
// — every downstream rank then resolves to null, the same as "uncommitted."
function commitOrder(gitCwd) {
  try {
    return execFileSync('git', ['log', '--format=%H'], { cwd: gitCwd }).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// filePath's position in `order` (0 = most recent commit in the repo), or null if git can't place it (not
// a repo, the file was never committed, git unavailable). Lower rank = more recently touched.
function lastCommitRank(filePath, gitCwd, order) {
  try {
    const sha = execFileSync('git', ['log', '-1', '--format=%H', '--', filePath], { cwd: gitCwd }).toString().trim();
    if (!sha) return null;
    const idx = order.indexOf(sha);
    return idx === -1 ? null : idx;
  } catch {
    return null;
  }
}

// True when `gitCwd` is a shallow clone (e.g. actions/checkout's default fetch-depth: 1) — commitOrder then
// sees only the truncated history it was given, not the repo's real graph. False on any git failure (not a
// repo, git unavailable): that absence is already reported by commitOrder/lastCommitRank returning null,
// not this function's job to re-diagnose.
function isShallowRepo(gitCwd) {
  try {
    return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: gitCwd }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

// Resolve a --baseline argument (a dir or a baseline.json path) to the baseline.json file. With no
// argument, pick the newest committed baseline under eval/baseline/. Dirs are `<date>-<shortsha>`; two
// baselines frozen on the same UTC date (plausible mid-tuning: freeze, tweak a case, re-freeze) tie on a
// bare name sort, breaking on the arbitrary short-SHA string — no relation to actual recency. Two prior
// fixes both failed on this same scenario: `generatedAt` carries the identical `YYYY-MM-DD` string the dir
// name is already built from (no finer granularity); comparing each commit's ISO timestamp still ties
// when — as is common for a scripted freeze/re-freeze — both commits land in the same second. Rank by
// position in the commit GRAPH instead (commitOrder/lastCommitRank): unambiguous even for same-second
// commits, since a child's parent pointer fixes order regardless of clock resolution. An UNCOMMITTED
// baseline.json (rank null — no commit touches it yet, the exact "just froze it, about to gate" moment)
// ranks as MORE recent than even the latest real commit, not less.
//
// A GENUINE TIE between the top two ranked candidates — including the shallow-clone case (actions/
// checkout's default fetch-depth: 1 truncates history to the boundary commit; git then reports THAT one
// commit as the last to touch every path present in its tree, verified empirically, so every real baseline
// ties at the same rank) — is refused outright rather than resolved by name order: a wrong SILENT pick is
// worse than a loud stop naming the fix. This is deliberately NOT a raw "more than one committed baseline"
// gate: that over-refuses a fully decidable case (one candidate genuinely uncommitted among several
// committed ones already wins outright, tying with nothing) purely because more than one dir happens to
// exist. Rank first, refuse only an actual tie. [LAW:no-silent-failure]
function resolveBaselineJsonPath(arg, gitCwd = __dirname) {
  if (arg) {
    const resolved = path.resolve(arg);
    if (!fs.existsSync(resolved)) throw new Error(`--baseline path not found: ${resolved}.`);
    const jsonPath = fs.statSync(resolved).isDirectory() ? path.join(resolved, 'baseline.json') : resolved;
    if (!fs.existsSync(jsonPath)) throw new Error(`No baseline.json at ${jsonPath}.`);
    return jsonPath;
  }
  const root = path.resolve('eval/baseline');
  if (!fs.existsSync(root)) throw new Error(`No baseline dir at ${root} and no --baseline given. Freeze one with eval/baseline.js first.`);
  const dirNames = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'baseline.json')))
    .map(e => e.name);
  if (dirNames.length === 0) throw new Error(`No committed baseline (a dir with baseline.json) under ${root}.`);
  const order = commitOrder(gitCwd);
  const rankKey = (rank) => (rank === null ? -1 : rank); // uncommitted (-1) ranks before even the newest real commit (0)
  const candidates = dirNames
    .map((name) => {
      const jsonPath = path.join(root, name, 'baseline.json');
      return { name, jsonPath, rank: lastCommitRank(jsonPath, gitCwd, order) };
    })
    .sort((a, b) => rankKey(a.rank) - rankKey(b.rank)); // ascending: index 0 (most recent) sorts first
  if (candidates.length > 1 && rankKey(candidates[0].rank) === rankKey(candidates[1].rank)) {
    const shallowHint = isShallowRepo(gitCwd)
      ? `this is a shallow git clone, so the commit-history tie-break has no real history to rank them by — run 'git fetch --unshallow' first, or `
      : '';
    throw new Error(`Cannot pick the newest committed baseline under ${root}: '${candidates[0].name}' and '${candidates[1].name}' tie (${shallowHint}name --baseline explicitly to disambiguate).`);
  }
  return candidates[0].jsonPath;
}

// Spawn a dev CLI (run-case.js / score.js) with stdio inherited so its progress streams live, and abort the
// whole gate if it fails — a partial or errored candidate must never be silently scored. [LAW:no-silent-failure]
function runCli(scriptPath, args, label) {
  const res = spawnSync('node', [scriptPath, ...args], { stdio: 'inherit', env: process.env });
  if (res.error) throw new Error(`${label} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label} exited ${res.status === null ? `on signal ${res.signal}` : `with code ${res.status}`}.`);
}

// Two independent facts, two independent failures: a `status` failure (submodule/ownership issue, the
// process being killed) must never discard a SHA `rev-parse` already obtained — that SHA feeds both the
// rendered verdict and the candidate's `buildBaseline` provenance, so losing it downgrades a real, known
// commit to the generic 'working-tree' label with no indication anything went wrong. [LAW:no-silent-failure]
function gitShaAndDirty() {
  let sha = null;
  try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname }).toString().trim(); } catch { /* no git / not a repo */ }
  let dirty = false;
  try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: __dirname }).toString().trim().length > 0; } catch { /* unknown — reported as clean, not fatal */ }
  return { sha, dirty };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // 1. --out names where FRESH artifacts land; --reuse-candidate names an EXISTING root to read from.
  //    Passing both silently discarded --out in favor of the reused root — a candidateRoot a user asked
  //    for by name that verdict.{md,json} then never appear under. Refuse the combination outright rather
  //    than pick a silent winner. [LAW:no-silent-failure]
  if (opts.out && opts.reuseCandidate) {
    throw new Error(`--out and --reuse-candidate are mutually exclusive: --reuse-candidate names an existing root to read from and gate; there is nothing fresh for --out to name. Pass one or the other.`);
  }

  // 2. Load the frozen baseline. Parse the raw object once for the cost preview (parseBaseline is a lossy
  //    GATE SUBSET that deliberately drops cost — do not widen it), and parseBaseline for the gate contract.
  const baselineJsonPath = resolveBaselineJsonPath(opts.baseline);
  const rawBaselineText = fs.readFileSync(baselineJsonPath, 'utf8');
  const baseline = parseBaseline(rawBaselineText, baselineJsonPath);
  const rawBaselineSuite = JSON.parse(rawBaselineText).suite;
  const repeats = baseline.repeats;

  const casesDir = path.resolve(opts.casesDir);
  const runCaseScript = path.join(__dirname, 'run-case.js');
  const scoreScript = path.join(__dirname, 'score.js');

  // The pre-spend guards below (3-3c) all share one shape: refuse BEFORE any replay when the thing they
  // check is knowable without running the candidate engine at all. None of them apply under
  // --reuse-candidate, which replays nothing — compareVerdict's own checks (matcher, engine, pooled
  // opportunities), reading the reused summaries' ACTUAL recorded values, are the universal backstop for
  // that path. [LAW:no-silent-failure]
  if (!opts.reuseCandidate) {
    // 3. Fail BEFORE spending an hour on a matcher that can't be compared: the candidate is scored with
    //    opts.matcher, which must yield the baseline's exact matcher label.
    if (baseline.matcher) {
      const wouldBe = expectedMatcherLabel(opts.matcher);
      if (wouldBe !== baseline.matcher) {
        throw new Error(`Matcher mismatch: --matcher ${opts.matcher} scores as '${wouldBe}' but the baseline used '${baseline.matcher}'. Pass the matcher the baseline was built with.`);
      }
    }

    // 3a. Fail BEFORE spending if the 'llm' matcher's credential is missing — score.js's makeLlmJudge
    //     would otherwise throw only once a case's replay is already complete and its OWN score.js
    //     invocation runs, wasting that case's real spend on a run this file was never going to be able
    //     to score.
    if (opts.matcher === 'llm') requireLlmJudgeCredential();

    // 3b. Fail BEFORE spending on a denominator that's already known to mismatch: each case's pooled
    //     inventory opportunity count is a PURE function of its current expected.json (findings annotated
    //     must-find, any round) — it does not depend on what the candidate engine produces, so it costs
    //     nothing to check here.
    const mustFindCountsByCase = {};
    for (const { case: name } of baseline.cases) {
      const expectedPath = path.join(casesDir, name, 'expected.json');
      if (!fs.existsSync(expectedPath)) throw new Error(`Baseline case '${name}' has no frozen case at ${path.join(casesDir, name)} — cannot replay it.`);
      const expected = parseExpected(fs.readFileSync(expectedPath, 'utf8'), expectedPath);
      mustFindCountsByCase[name] = expected.findings.filter(f => f.annotation === 'must-find').length;
    }
    const currentOpportunities = computeExpectedOpportunities(mustFindCountsByCase, repeats);
    if (currentOpportunities !== baseline.pooledInventoryMustFind.opportunities) {
      throw new Error(`Incomparable: the golden suite's current pooled inventory opportunities (${currentOpportunities}) differ from the baseline's (${baseline.pooledInventoryMustFind.opportunities}) — expected.json changed since the baseline was frozen. Re-freeze the baseline before gating against this expected.json.`);
    }

    // 3c. Fail BEFORE spending on engine drift — a FULL pass over every case, not a check folded into the
    //     replay loop below: if only a LATER case's engine pin had drifted, folding it into that loop would
    //     let every EARLIER case fully replay and score (real spend) before the mismatch is even reached.
    //     run-case.js's own assertConfigMatchesPin only verifies the resolved config against THIS
    //     case.json's own pin — never against baseline.engine, the pin frozen at baseline-freeze time — so
    //     a drifted pin would otherwise only be caught by compareVerdict's sameEngine check, after the
    //     ENTIRE suite has replayed and scored.
    if (baseline.engine) {
      for (const { case: name } of baseline.cases) {
        const caseJsonPath = path.join(casesDir, name, 'case.json');
        if (!fs.existsSync(caseJsonPath)) throw new Error(`Baseline case '${name}' has no frozen case at ${path.join(casesDir, name)} — cannot replay it.`);
        const casePinEngine = parseCaseEngine(fs.readFileSync(caseJsonPath, 'utf8'), caseJsonPath);
        if (!sameEngine(casePinEngine, baseline.engine)) {
          throw new Error(`Incomparable: case '${name}' pins engine ${JSON.stringify(casePinEngine)} but the baseline pins ${JSON.stringify(baseline.engine)} — the case's pin drifted since the baseline was frozen. Re-freeze the baseline, or fix the case's pin, before gating.`);
        }
      }
    }
  }

  // 4. Candidate artifact root — isolated from the baseline's own eval/out/<case> runs so score.js never
  //    pools baseline + candidate run dirs together. Under eval/out/ (git-ignored) by default.
  const candidateRoot = opts.reuseCandidate
    ? path.resolve(opts.reuseCandidate)
    : path.resolve(opts.out || path.join('eval', 'out', `candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`));

  process.stderr.write(`\nBaseline: ${baselineJsonPath}\n`);
  process.stderr.write(`  ${baseline.mainSha.slice(0, 7)} · engine ${baseline.engine ? `${baseline.engine.provider}/${baseline.engine.model}` : '(unpinned)'} · N=${repeats} · matcher ${baseline.matcher || '(none)'}\n`);
  process.stderr.write(`  gate floor ${pct(baseline.pooledInventoryMustFind.gateFloor)} (baseline pooled ${pct(baseline.pooledInventoryMustFind.rate)}, ${baseline.pooledInventoryMustFind.found}/${baseline.pooledInventoryMustFind.opportunities})\n`);

  if (opts.reuseCandidate) {
    // --matcher (default 'llm' even when never passed) has no effect in this branch: no scoring runs here,
    // and compareVerdict checks the reused summaries' ACTUAL recorded matcher, not opts.matcher. Loud about
    // it rather than a silent no-op, the same reasoning that made --out + --reuse-candidate an outright
    // refusal above — except here there's a principled winner (the reused data), just not the flag's value.
    process.stderr.write(`\nReusing candidate artifacts under ${candidateRoot} (no replay, no spend). --matcher is ignored in this mode — the reused summaries' own recorded matcher is what's checked.\n`);
  } else {
    // 5. Refuse a non-fresh --out: run-case.js is append-only (never cleans <out>/<case>/) and score.js's
    //    findRunDirs pools EVERY run dir under a case's output root — stale, fresh, whichever — into one
    //    scorecard-summary.json. Reusing an --out that already has a case's run artifacts would silently
    //    blend runs from two different working-tree states into a single candidate summary, with no error
    //    (and possibly no N mismatch either, if the counts happen to add up). The default --out is always a
    //    fresh timestamped path, so this only fires when --out is passed explicitly at an existing location.
    for (const { case: name } of baseline.cases) {
      const caseOutDir = path.join(candidateRoot, name);
      const hasRunDirs = fs.existsSync(caseOutDir) && fs.readdirSync(caseOutDir, { withFileTypes: true })
        .some(e => e.isDirectory() && fs.existsSync(path.join(caseOutDir, e.name, 'findings.json')));
      if (hasRunDirs) {
        throw new Error(`--out ${candidateRoot} already has run artifacts for case '${name}' at ${caseOutDir} — run-case.js is append-only and would blend them with fresh runs into one summary. Pick a fresh --out, or remove ${caseOutDir} first.`);
      }
    }

    // 6. COST GUARDRAIL — print the estimate up front, before spending. [LAW:verifiable-goals]
    const estUsd = estimateCandidateCostUsd(rawBaselineSuite, repeats);
    process.stderr.write(`\nAbout to replay ${baseline.cases.length} case(s) × N=${repeats} against the WORKING TREE, then score.\n`);
    process.stderr.write(`Estimated cost ≈ ${estUsd === null ? 'unknown (baseline recorded no per-run cost)' : `$${estUsd.toFixed(2)}`} (from the baseline's recorded $/full-run × N). Actual varies with model stochasticity.\n\n`);

    // 7. Replay + score each baseline case into the candidate root. Iterate the BASELINE's case set so the
    //    candidate covers exactly it (an added-since golden case can't be gated — the baseline doesn't cover
    //    it). Every pre-spend guard above already ran as a full pass over this same set, so nothing here
    //    re-checks case.json existence or the engine pin.
    for (const { case: name } of baseline.cases) {
      const caseDir = path.join(casesDir, name);
      process.stderr.write(`\n─── ${name}: replaying ${repeats}× ───\n`);
      runCli(runCaseScript, [caseDir, '-n', String(repeats), '--out', candidateRoot, '--workers', String(opts.workers)], `run-case (${name})`);
      process.stderr.write(`\n─── ${name}: scoring ───\n`);
      runCli(scoreScript, [path.join(candidateRoot, name), '--matcher', opts.matcher, '--cases-dir', casesDir, '--cache', path.resolve(opts.cache)], `score (${name})`);
    }
  }

  // 8. Reduce the candidate's scored summaries into a suite with the SAME buildBaseline the frozen baseline
  //    used — producer and comparator can't drift. Read each case's summary + its pinned engine, exactly as
  //    baseline.js's main() does.
  const { sha: candidateSha, dirty } = gitShaAndDirty();
  const candidateCases = baseline.cases.map(({ case: name }) => {
    const summaryPath = path.join(candidateRoot, name, 'scorecard-summary.json');
    if (!fs.existsSync(summaryPath)) throw new Error(`No candidate summary for case '${name}' at ${summaryPath}. ${opts.reuseCandidate ? 'The reused root is incomplete.' : 'The replay/score step did not produce it.'}`);
    const summary = parseCaseSummary(fs.readFileSync(summaryPath, 'utf8'), summaryPath);
    if (summary.case !== name) throw new Error(`${summaryPath} names case '${summary.case}' but lives under '${name}'.`);
    const engine = parseCaseEngine(fs.readFileSync(path.join(casesDir, name, 'case.json'), 'utf8'), path.join(casesDir, name, 'case.json'));
    return { summary, engine };
  });
  const candidateSuite = buildBaseline({ cases: candidateCases, provenance: { sha: candidateSha || 'working-tree', date: new Date().toISOString().slice(0, 10) } });

  // 9. THE VERDICT.
  const verdict = compareVerdict(baseline, candidateSuite);
  const cost = {
    baselinePerRun: rawBaselineSuite ? rawBaselineSuite.costPerFullRunUsd ?? null : null,
    candidatePerRun: candidateSuite.suite.costPerFullRunUsd,
    delta: null,
  };
  if (typeof cost.baselinePerRun === 'number' && typeof cost.candidatePerRun === 'number') cost.delta = cost.candidatePerRun - cost.baselinePerRun;
  const md = renderVerdictMarkdown(verdict, { candidateSha: candidateSha ? candidateSha.slice(0, 7) : null, dirty, baselineSha: baseline.mainSha, cost });

  // Write the verdict alongside the candidate artifacts (2fk.6 reads verdict.md into a Step Summary), and
  // print it to stdout so it's pasteable straight into a PR body.
  try {
    fs.mkdirSync(candidateRoot, { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, 'verdict.md'), md);
    fs.writeFileSync(path.join(candidateRoot, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`(warning: could not write verdict artifacts under ${candidateRoot}: ${e.message})\n`);
  }
  process.stdout.write('\n' + md);
  process.stderr.write(`\nVerdict artifacts → ${candidateRoot}/verdict.{md,json}\n`);

  // Non-zero exit on DEGRADED so the gate is mechanical (CI, 2fk.6). OK/IMPROVED exit 0.
  return verdict.degraded ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`compare: ${err.message}\n`);
    process.exit(2); // 2 = the gate could not run (distinct from 1 = ran and DEGRADED).
  }
}

module.exports = {
  parseArgs, parsePositiveInt, expectedMatcherLabel, estimateCandidateCostUsd,
  compareVerdict, renderVerdictMarkdown, resolveBaselineJsonPath, computeExpectedOpportunities,
};
