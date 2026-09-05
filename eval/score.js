#!/usr/bin/env node
'use strict';
// Score one case's REPLAY ARTIFACTS (eval/out/<case>/<ts>-run<i>/, produced by eval/run-case.js)
// against the case's frozen expected inventory (eval/cases/<case>/expected.json). It answers the
// question the eval harness exists to answer: "did this run still find the known high-quality
// findings?" — as a MEASURED verdict (must-find recall), not a guess. [LAW:verifiable-goals]
//
// This is an INSTRUMENT, not a second review implementation: it never re-runs the engine (run-case.js
// does that) and never re-derives the expected set (the frozen expected.json is the ground truth). It
// only MATCHES two frozen record sets and reduces the match to metrics. [LAW:decomposition]
//
// The match is two stages, cheap first:
//   1. Candidate pairing — pure, deterministic: a produced finding can match an expected one only when
//      the path is identical AND the new-file line is within LINE_WINDOW (a finding legitimately anchors
//      a few lines off — partitionFindings' MAX_ANCHOR_SNAP_DISTANCE is the precedent for tolerating slip).
//   2. Semantic identity — does the PRODUCED body describe the SAME defect as the EXPECTED body? This is
//      the one judgment that isn't lexical, so it's the one EFFECT: an injected `judge(pairs)` function.
//      Production uses an LLM judge (a cheap pinned model) behind a content-keyed cache; tests inject a
//      deterministic fake. The scoring core never knows which. [LAW:effects-at-boundaries]
//
// Determinism (the primary acceptance criterion — "scoring the same findings.json twice yields the
// identical scorecard") is a STRUCTURAL property of the cache, not a hope about LLM temperature: the
// first scoring populates a content-keyed cache; every later scoring reads it, so the judge is never
// re-consulted for a pair it has already ruled on. [LAW:one-source-of-truth]
//
//   ANTHROPIC_API_KEY=… node eval/score.js <case-out-dir> [--matcher llm|lexical] [--cases-dir <dir>]
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib. Every world-effect (fs, fetch, env) lives
// inside main() or the boundary judge, so importing this file for the pure-helper tests performs no IO and
// makes no network call.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// The judge is the SCORER'S OWN measurement instrument, pinned independently of whatever engine a case
// replayed on, so a score means the same thing across every case — and, critically, so a change to the
// engine under test cannot move the ruler measuring it. Anthropic's own Messages API + a cheap DATED
// model snapshot: a snapshot id, not a floating alias, because an alias that silently rolls to a new
// model would re-point the instrument between a baseline freeze and the candidate compared against it.
// Kept local (not imported from src/provider.js) because this is the instrument's config, a concern the
// scorer owns, not the reviewed engine's. [LAW:decomposition]
//
// Was DeepSeek (deepseek-v4-flash) through 2026-08. Moved off it when that account went to a hard 402
// and the provider left the engine's live set: a judge nobody can call is not an instrument, and a
// baseline is worthless if its scores cannot be reproduced. [LAW:one-source-of-truth] The cache key
// hashes JUDGE_MODEL (judgeCacheKey below), so this move invalidates every ruling made by the old judge
// rather than silently mixing two judges' verdicts in one scorecard.
const JUDGE_BASE_URL = 'https://api.anthropic.com';
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
// The single place ANTHROPIC_API_KEY is read for the 'llm' matcher's credential — main() below and
// compare.js's pre-loop guard (checking "would scoring succeed" before any replay spend) both call this,
// so the requirement can't drift into two independently-typed checks of the same env var.
// [LAW:one-source-of-truth] Deliberately NOT the engine's credential: an api-key judge stays callable
// and identically-priced whichever provider a case pins, including a subscription one whose OAuth token
// is valid for the CLI's own calls and nothing else.
function requireLlmJudgeCredential() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('The llm matcher needs ANTHROPIC_API_KEY (or pass --matcher lexical for the offline fallback).');
  return apiKey;
}
// The exact matcher label a scorecard-summary.json's `matcher` field carries for a given --matcher kind —
// the SINGLE producer of this format. main() below and compare.js's pre-spend comparability check
// (expectedMatcherLabel, an alias of this) both call it, so the label FORMAT ('llm/<model>' vs a second,
// independently-typed template) can never drift out of sync with what main() actually writes.
// [LAW:one-source-of-truth]
function matcherLabel(kind) {
  if (kind === 'lexical') return 'lexical';
  if (kind === 'llm') return `llm/${JUDGE_MODEL}`;
  throw new Error(`Unknown matcher kind ${JSON.stringify(kind)} (expected 'llm' or 'lexical').`);
}
// [LAW:one-source-of-truth] The cache is keyed by this token, so a change to the judge PROMPT or the model
// can never silently reuse a decision made under the old regime — bump it whenever either changes.
const JUDGE_VERSION = 'judge-v1';
// Stage-1 line-proximity window: a produced finding within this many new-file lines of an expected one is
// a candidate. Mirrors the intent of MAX_ANCHOR_SNAP_DISTANCE (src/review.js) — tolerate small anchor slip
// rather than miss a real match on a one-line offset.
const LINE_WINDOW = 10;
// Lexical fallback threshold: Jaccard word-overlap ≥ this ⇒ match. Only used by the --matcher lexical path.
const LEXICAL_THRESHOLD = 0.5;
// Uncached pairs per judge request. Bounds prompt size; a case's candidate set is small, so this rarely
// splits, but it keeps a pathological run from building one enormous prompt.
const JUDGE_BATCH_SIZE = 12;

const ANNOTATIONS = new Set(['must-find', 'nice-to-find', 'noise']);

const USAGE = `Score a case's replay artifacts against its frozen expected inventory: must-find recall
(the primary gate number), plus nice-to-find recall, noise count, and cost (secondary).

Usage: ANTHROPIC_API_KEY=… node eval/score.js <case-out-dir> [options]

  <case-out-dir>       A case's output root under eval/out (e.g. eval/out/cc-candybar-150-transcript-perf).
                       Every run dir under it (a dir containing findings.json) is scored.
  --matcher <kind>     Semantic matcher: 'llm' (default, pinned Anthropic judge + cache) or 'lexical' (offline,
                       deterministic word-overlap — no network, no credential).
  --cases-dir <dir>    Where the frozen cases live (default: eval/cases). expected.json is read from
                       <cases-dir>/<case>/ (the case name comes from each run's meta.json).
  --cache <file>       Judge-decision cache (default: eval/out/.judge-cache.json). Keying makes re-scoring
                       deterministic; delete it to force a fresh LLM pass.
  --help               Show this help.

Writes scorecard.json into each run dir and scorecard-summary.json at the case-out root, and prints a
mean/min/max recall table across the runs. The 'llm' matcher reads the credential from ANTHROPIC_API_KEY.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Argument parsing (pure)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:parse-dont-validate] Flags + one required positional map to a plain options value; no IO. Mirrors
// run-case.js's parser: `--flag value` and `--flag=value` both work; an unknown flag or a missing value
// aborts here, at the boundary, so nothing downstream re-checks. [LAW:no-silent-failure]
function parseArgs(argv) {
  const opts = { caseOutDir: null, matcher: 'llm', casesDir: 'eval/cases', cache: 'eval/out/.judge-cache.json' };
  const known = new Set(['matcher', 'cases-dir', 'cache']);
  const keyFor = { 'cases-dir': 'casesDir' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('-')) {
      if (opts.caseOutDir !== null) throw new Error(`Unexpected second positional argument: ${arg} (only <case-out-dir> is positional).`);
      opts.caseOutDir = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const rawName = arg.slice(2, eq === -1 ? undefined : eq);
    if (!known.has(rawName)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    // [LAW:no-silent-failure] A space-separated value that is itself a long option is a missing value, not
    // a literal argument — consuming it would swallow the next flag and drop the user's intent.
    let value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error(`Option --${rawName} requires a value.`);
    opts[keyFor[rawName] || rawName] = value;
  }
  if (opts.caseOutDir === null) throw new Error('Missing required <case-out-dir> argument. See --help.');
  if (opts.matcher !== 'llm' && opts.matcher !== 'lexical') throw new Error(`--matcher must be 'llm' or 'lexical' (got ${JSON.stringify(opts.matcher)}).`);
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Input parsers (parse-dont-validate) — each returns a value whose existence proves the fields the scorer
// consumes are present and well-typed, so nothing downstream re-checks. A malformed input aborts here,
// naming the file and field, never later as a confusing metric. [LAW:no-silent-failure]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${e.message}`);
  }
}

// [LAW:single-enforcer] The one boundary for every object-shaped input (expected.json, usage.json,
// meta.json, the judge cache): valid-but-wrong-typed JSON (a number, string, array, or null) parses fine
// but then breaks any field access downstream, so the parse isn't done until the object shape is proven
// here — one definition of "valid JSON that is a plain object", not a copy per caller. Array-shaped input
// (findings.json) stays on parseJson, which requires the array itself. [LAW:parse-dont-validate]
function parseJsonObject(raw, label) {
  const json = parseJson(raw, label);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error(`${label} is not a JSON object (found ${json === null ? 'null' : Array.isArray(json) ? 'array' : typeof json}).`);
  }
  return json;
}

// The frozen ground truth. Only the fields the scorer matches on are required — path/line for stage-1
// pairing, annotation for bucketing, body for the semantic judge, commentId for traceability back to the
// source PR. An UNREVIEWED annotation is intentionally loud: an un-annotated case must never be silently
// scored (it would report a meaningless recall). [LAW:no-silent-failure]
//
// The findings array is the case's POOLED INVENTORY — every distinct finding of the source PR that exists
// in the frozen material, whichever review round reported it. A finding's `reviewId` names its source
// round; absent, it belongs to the frozen round (the top-level reviewId), so a pre-inventory case parses
// unchanged. The optionality is resolved HERE, once: every finding leaves this boundary with a concrete
// reviewId, and the frozen-round vs whole-inventory views downstream are derived subsets of this one
// array — never a second copy. [LAW:one-source-of-truth] [LAW:parse-dont-validate]
function parseExpected(raw, label) {
  const json = parseJsonObject(raw, label);
  if (!Number.isInteger(json.reviewId)) throw new Error(`${label} has no integer top-level 'reviewId' (the frozen round).`);
  if (!Array.isArray(json.findings)) throw new Error(`${label} has no 'findings' array.`);
  const findings = json.findings.map((f, i) => {
    const at = `${label} findings[${i}]`;
    if (typeof f.path !== 'string' || f.path.trim() === '') throw new Error(`${at} has an invalid path.`);
    if (!Number.isInteger(f.line) || f.line <= 0) throw new Error(`${at} has an invalid line.`);
    if (typeof f.body !== 'string' || f.body.trim() === '') throw new Error(`${at} has an invalid body.`);
    if (f.annotation === 'UNREVIEWED') throw new Error(`${at} is still UNREVIEWED — annotate the case (must-find | nice-to-find | noise) before scoring it.`);
    if (!ANNOTATIONS.has(f.annotation)) throw new Error(`${at} has an invalid annotation ${JSON.stringify(f.annotation)} (expected must-find | nice-to-find | noise).`);
    if (f.reviewId !== undefined && !Number.isInteger(f.reviewId)) throw new Error(`${at} has a non-integer reviewId ${JSON.stringify(f.reviewId)}.`);
    return { commentId: f.commentId ?? null, path: f.path.trim(), line: f.line, annotation: f.annotation, body: f.body, reviewId: f.reviewId ?? json.reviewId };
  });
  return { reviewId: json.reviewId, findings };
}

// The raw merged findings from runMultiScope, PRE anchor-partition (run-case.js writes them). Same shape a
// worker records through request_change: { path, line, body, severity }.
function parseProduced(raw, label) {
  const json = parseJson(raw, label);
  if (!Array.isArray(json)) throw new Error(`${label} must be a JSON array of findings.`);
  return json.map((f, i) => {
    const at = `${label}[${i}]`;
    if (typeof f.path !== 'string' || f.path.trim() === '') throw new Error(`${at} has an invalid path.`);
    if (!Number.isInteger(f.line) || f.line <= 0) throw new Error(`${at} has an invalid line.`);
    if (typeof f.body !== 'string' || f.body.trim() === '') throw new Error(`${at} has an invalid body.`);
    return { path: f.path.trim(), line: f.line, body: f.body, severity: f.severity ?? null };
  });
}

// usage.json is passed through to the scorecard as the secondary cost metric — the scorer neither prices
// nor recomputes it (run-case.js already captured it from the engine). Missing fields become null rather
// than aborting: a run with no usage is still scorable for recall (the primary metric).
function parseUsage(raw, label) {
  const json = parseJsonObject(raw, label);
  return {
    // The disjoint token record and the pass's time span, passed through as written (see THE TOKEN
    // RECORD in src/usage.js). The scorer neither prices nor validates them — it reduces `cost` and
    // echoes the rest — so a run captured before the split, which carries a collapsed
    // inputTokens/outputTokens pair instead, records its tokens as absent rather than as zero.
    // [LAW:no-silent-failure] a baseline that cannot be repriced must say so, not report free tokens.
    tokens: json.tokens ?? null,
    span: json.span ?? null,
    cost: json.cost ?? null,
  };
}

// meta.json carries provenance the scorer reads instead of parsing the run-dir name: the case name (which
// resolves expected.json) and the resolved engine config (echoed into the scorecard). [LAW:one-source-of-truth]
function parseMeta(raw, label) {
  const json = parseJsonObject(raw, label);
  if (typeof json.case !== 'string' || json.case.trim() === '') throw new Error(`${label} has no 'case' name.`);
  if (json.case !== path.basename(json.case) || json.case === '.' || json.case === '..') {
    throw new Error(`${label} 'case' must be a plain directory component, got ${JSON.stringify(json.case)}.`);
  }
  return { case: json.case, config: json.config ?? null };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure scoring
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Body normalized for content-hashing and lexical overlap: collapse whitespace, lowercase. Same shape as
// src/review.js's normalizeBody, for the same reason — two renderings of one finding must hash identically.
function normalizeBody(body) {
  return (body || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Stage 1 (pure, deterministic): every (expected, produced) pair whose path is identical and whose lines
// are within `window`. The SAME set of pairs is produced on every run for the same inputs — the semantic
// judge only ever rules on this narrowed set. [LAW:dataflow-not-control-flow]
function pairCandidates(expected, produced, window) {
  const pairs = [];
  for (let ei = 0; ei < expected.length; ei++) {
    for (let pi = 0; pi < produced.length; pi++) {
      if (expected[ei].path !== produced[pi].path) continue;
      const lineDelta = produced[pi].line - expected[ei].line;
      if (Math.abs(lineDelta) > window) continue;
      pairs.push({ key: `${ei}:${pi}`, expectedIdx: ei, producedIdx: pi, lineDelta });
    }
  }
  return pairs;
}

// Stage 2 → metrics (pure): apply the judge's decisions to the candidate pairs and reduce to the buckets.
// An expected finding is FOUND if ANY candidate pair with match:true names it; a produced finding is NOISE
// if no candidate pair with match:true names it (it matched nothing in the whole inventory — matching a
// later-round finding is an early find, the epic's goal, never noise). [LAW:no-silent-failure] Every
// candidate pair MUST carry a decision — a missing one is a bug in the judge, not a silent no-match.
//
// `expected` is parseExpected's {reviewId, findings}: matching runs over the WHOLE inventory uniformly,
// and the two reported views — the frozen round (existing buckets, unchanged for pre-inventory cases) and
// the pooled inventory (all rounds) — are derived per-bucket filters over the same matched set.
// [LAW:dataflow-not-control-flow]
function computeMetrics(expected, produced, candidatePairs, decisions) {
  const findings = expected.findings;
  const expectedMatched = new Set();
  const producedMatched = new Set();
  const pairDetail = [];
  for (const pair of candidatePairs) {
    const d = decisions.get(pair.key);
    if (!d) throw new Error(`Judge returned no decision for candidate pair ${pair.key}.`);
    pairDetail.push({
      expectedCommentId: findings[pair.expectedIdx].commentId,
      expectedAnnotation: findings[pair.expectedIdx].annotation,
      expectedReviewId: findings[pair.expectedIdx].reviewId,
      produced: `${produced[pair.producedIdx].path}:${produced[pair.producedIdx].line}`,
      lineDelta: pair.lineDelta,
      match: d.match,
      reason: d.reason,
    });
    if (d.match) {
      expectedMatched.add(pair.expectedIdx);
      producedMatched.add(pair.producedIdx);
    }
  }
  const bucket = (annotation, member) => {
    const idxs = [];
    for (let i = 0; i < findings.length; i++) if (findings[i].annotation === annotation && member(findings[i])) idxs.push(i);
    const foundIdxs = idxs.filter(i => expectedMatched.has(i));
    return {
      total: idxs.length,
      found: foundIdxs.length,
      recall: idxs.length ? foundIdxs.length / idxs.length : null,
      foundIds: foundIdxs.map(i => findings[i].commentId),
      missedIds: idxs.filter(i => !expectedMatched.has(i)).map(i => findings[i].commentId),
    };
  };
  const frozenRound = (f) => f.reviewId === expected.reviewId;
  const anyRound = () => true;
  const noiseIdxs = [];
  for (let i = 0; i < produced.length; i++) if (!producedMatched.has(i)) noiseIdxs.push(i);
  return {
    mustFind: bucket('must-find', frozenRound),
    niceToFind: bucket('nice-to-find', frozenRound),
    knownNoise: bucket('noise', frozenRound),
    inventoryMustFind: bucket('must-find', anyRound),
    inventoryNiceToFind: bucket('nice-to-find', anyRound),
    inventoryKnownNoise: bucket('noise', anyRound),
    noise: {
      count: noiseIdxs.length,
      items: noiseIdxs.map(i => ({ path: produced[i].path, line: produced[i].line, severity: produced[i].severity, bodyPreview: bodyPreview(produced[i].body) })),
    },
    pairs: pairDetail,
  };
}

function bodyPreview(body) {
  const flat = (body || '').replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? flat.slice(0, 137) + '…' : flat;
}

// Score one run: narrow to candidate pairs, consult the injected judge on their bodies, reduce to metrics.
// The judge is the only effect and it's a parameter — in tests it's a deterministic fake, in production
// it's the LLM+cache. [LAW:effects-at-boundaries] The output carries no timestamp or ambient value, so it
// is byte-stable across re-scorings that share a judge cache. [LAW:one-source-of-truth]
async function scoreRun({ expected, produced, usage, meta, judge, matcherLabel }) {
  const candidatePairs = pairCandidates(expected.findings, produced, LINE_WINDOW);
  const judgePairs = candidatePairs.map(p => ({
    key: p.key,
    expectedBody: expected.findings[p.expectedIdx].body,
    producedBody: produced[p.producedIdx].body,
  }));
  const decisions = await judge(judgePairs);
  const metrics = computeMetrics(expected, produced, candidatePairs, decisions);
  return {
    case: meta.case,
    config: meta.config,
    matcher: matcherLabel,
    findingCount: produced.length,
    candidatePairs: candidatePairs.length,
    mustFind: metrics.mustFind,
    niceToFind: metrics.niceToFind,
    knownNoise: metrics.knownNoise,
    inventoryMustFind: metrics.inventoryMustFind,
    inventoryNiceToFind: metrics.inventoryNiceToFind,
    inventoryKnownNoise: metrics.inventoryKnownNoise,
    noise: metrics.noise,
    usage,
    pairs: metrics.pairs,
  };
}

// Reduce a case's per-run scorecards to a mean/min/max band per metric. Null recalls (a bucket with zero
// expected findings) are skipped, never counted as zero. This is the shape baseline.js (freeze/variance) reads.
function aggregateRuns(caseName, scorecards) {
  const band = (values) => {
    const nums = values.filter(v => v !== null && v !== undefined);
    if (nums.length === 0) return { mean: null, min: null, max: null, n: 0 };
    return {
      mean: nums.reduce((a, b) => a + b, 0) / nums.length,
      min: Math.min(...nums),
      max: Math.max(...nums),
      n: nums.length,
    };
  };
  // [LAW:one-source-of-truth] Only a DOLLARS-basis run contributes a cost figure. A run billed to
  // subscription quota carries a notional list price, not spend — folding it in here would let one
  // baseline mix two units and quietly compare list price against money. It reports null and lands
  // in the existing uncosted-run count, which the baseline report already states out loud.
  const costUsd = (u) => (u && u.cost && u.cost.basis === 'dollars' ? u.cost.usd : null);
  return {
    case: caseName,
    runs: scorecards.length,
    matcher: scorecards.length ? scorecards[0].matcher : null,
    mustFindRecall: band(scorecards.map(s => s.mustFind.recall)),
    inventoryMustFindRecall: band(scorecards.map(s => s.inventoryMustFind.recall)),
    niceToFindRecall: band(scorecards.map(s => s.niceToFind.recall)),
    inventoryNiceToFindRecall: band(scorecards.map(s => s.inventoryNiceToFind.recall)),
    noiseCount: band(scorecards.map(s => s.noise.count)),
    costUsd: band(scorecards.map(s => costUsd(s.usage))),
    perRun: scorecards.map(s => ({
      mustFind: `${s.mustFind.found}/${s.mustFind.total}`,
      inventoryMustFind: `${s.inventoryMustFind.found}/${s.inventoryMustFind.total}`,
      niceToFind: `${s.niceToFind.found}/${s.niceToFind.total}`,
      inventoryNiceToFind: `${s.inventoryNiceToFind.found}/${s.inventoryNiceToFind.total}`,
      noise: s.noise.count,
      costUsd: costUsd(s.usage),
    })),
  };
}

// Human-readable table across a case's runs. mean/min/max recall is the headline; per-run found/total is
// spelled out so a variance band is legible at a glance.
function renderTable(summary) {
  const pct = (v) => (v === null ? '  n/a' : `${(v * 100).toFixed(0).padStart(3)}%`);
  const num = (v) => (v === null ? 'n/a' : v.toFixed(2));
  const usd = (v) => (v === null ? 'n/a' : `$${v.toFixed(4)}`);
  const mf = summary.mustFindRecall;
  const inv = summary.inventoryMustFindRecall;
  const nf = summary.niceToFindRecall;
  const invNf = summary.inventoryNiceToFindRecall;
  const lines = [
    `Case: ${summary.case}   (matcher: ${summary.matcher}, ${summary.runs} run${summary.runs === 1 ? '' : 's'})`,
    `  must-find recall (frozen round):  mean ${pct(mf.mean)}  min ${pct(mf.min)}  max ${pct(mf.max)}`,
    `  inventory recall (all rounds):    mean ${pct(inv.mean)}  min ${pct(inv.min)}  max ${pct(inv.max)}   [PRIMARY]`,
    `  nice-to-find recall (frozen):     mean ${pct(nf.mean)}  min ${pct(nf.min)}  max ${pct(nf.max)}`,
    `  nice-to-find recall (inventory):  mean ${pct(invNf.mean)}  min ${pct(invNf.min)}  max ${pct(invNf.max)}`,
    `  noise / run:                      mean ${num(summary.noiseCount.mean)}  min ${num(summary.noiseCount.min)}  max ${num(summary.noiseCount.max)}`,
    `  cost / run (est.):                mean ${usd(summary.costUsd.mean)}`,
    `  per run (must·invMust·nice·invNice): ${summary.perRun.map(r => `${r.mustFind}·${r.inventoryMustFind}·${r.niceToFind}·${r.inventoryNiceToFind}`).join('   ')}`,
  ];
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The lexical matcher (pure, deterministic) — the offline fallback the ticket mandates when the LLM judge
// can't be trusted or reached. Jaccard word-overlap over normalized bodies; ≥ threshold ⇒ same defect.
// It is a legitimate judge (same `judge(pairs) → Map` shape), just a weaker one. [LAW:one-type-per-behavior]
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

function wordSet(body) {
  return new Set(normalizeBody(body).split(/[^a-z0-9]+/).filter(w => w.length > 2));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function makeLexicalJudge() {
  return async (pairs) => {
    const out = new Map();
    for (const p of pairs) {
      const sim = jaccard(wordSet(p.expectedBody), wordSet(p.producedBody));
      out.set(p.key, { match: sim >= LEXICAL_THRESHOLD, reason: `jaccard ${sim.toFixed(2)}` });
    }
    return out;
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The LLM judge (the boundary effect) — a cheap pinned model decides same-defect vs different-defect for
// each candidate pair, behind a content-keyed cache that makes re-scoring deterministic.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Cache key over the CONTENT (not the run-local pair index) so a decision survives reordering, re-runs,
// and different cases that happen to share a pair. Includes the judge version + model so a prompt/model
// change can't reuse stale rulings. [LAW:one-source-of-truth]
function judgeCacheKey(model, expectedBody, producedBody) {
  const h = crypto.createHash('sha256');
  h.update(JUDGE_VERSION);
  h.update('\x00');
  h.update(model);
  h.update('\x00');
  h.update(normalizeBody(expectedBody));
  h.update('\x00');
  h.update(normalizeBody(producedBody));
  return h.digest('hex');
}

// The judge instruction. Terse, one output contract, negative cases spelled out — the matcher must reward
// the same DEFECT, not the same file or topic, and must see through paraphrase and severity changes.
function buildJudgePrompt(batch) {
  const header = [
    'You are a strict code-review finding matcher. For each numbered pair below, decide whether the',
    'PRODUCED finding describes the SAME underlying defect as the EXPECTED finding — the same root cause at',
    'the same code location — that a reviewer would treat as one finding with one fix.',
    '',
    'Rules:',
    '- MATCH: same defect and same fix, even if the wording, structure, or stated severity differ.',
    '- NO-MATCH: different defects, even in the same function, on the same line, or about the same symbol.',
    '- Do not match on shared topic or shared file alone; the specific bug/issue must be the same.',
    '',
    'Output ONLY a JSON array, one object per pair, each exactly:',
    '  {"i": <pair number>, "match": <true|false>, "reason": "<at most 12 words>"}',
    'No prose, no markdown fences, nothing outside the array.',
    '',
  ];
  const body = batch.map((p, k) => [
    `Pair ${k + 1}:`,
    `EXPECTED: ${p.expectedBody}`,
    `PRODUCED: ${p.producedBody}`,
    '',
  ].join('\n'));
  return header.join('\n') + '\n' + body.join('\n');
}

// The DeepSeek Anthropic-compatible endpoint leads its content with a `thinking` block, so the answer is
// the LAST `text` block — never content[0]. [LAW:no-silent-failure] A missing text block is a loud failure.
function extractText(envelope) {
  const blocks = Array.isArray(envelope.content) ? envelope.content : [];
  const texts = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string');
  if (texts.length === 0) throw new Error(`Judge response carried no text block: ${JSON.stringify(envelope).slice(0, 300)}`);
  return texts[texts.length - 1].text;
}

// Extract the judge's decision list from its raw text. The output contract is "one decision object per
// pair"; the model honors it in more than one concrete shape — a JSON array for a multi-pair batch, a
// BARE OBJECT for a single-pair batch (`{"i":1,...}` not `[{"i":1,...}]`), and sometimes a STREAM of
// bare objects separated by blank lines (`{"i":1,...}\n\n{"i":2,...}`) — all valid instances of the same
// contract. [LAW:one-type-per-behavior] Every shape is read to ONE list of decision objects here, so
// parseJudgeResponse validates a single path: the array is preferred (a well-formed array whose text also
// contains braces is never mis-read as objects), and otherwise a balanced-brace scan collects every
// top-level object — which subsumes the single-bare-object case as a stream of length 1, one mechanism
// instead of two. [LAW:no-silent-failure] No shape present, or an unparseable object, ⇒ throw; complete-
// ness against the batch (every pair ruled) stays parseJudgeResponse's job.
function extractDecisionList(text) {
  const tryArray = () => {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return undefined;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return undefined; }
  };
  const arr = tryArray();
  if (Array.isArray(arr)) return arr;

  // Balanced-brace scan: each top-level {...} span (string-aware, so a brace inside a "reason" cannot
  // split an object) parses as one decision. A span that is not valid JSON fails the whole extraction
  // loudly — a half-readable response must never silently drop rulings.
  const objs = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"' && depth > 0) inString = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch {
          throw new Error(`Judge response object is not valid JSON: ${text.slice(start, i + 1).slice(0, 300)}`);
        }
      }
    }
  }
  if (objs.length > 0) return objs;
  throw new Error(`Judge response is not a JSON array or object: ${text.slice(0, 300)}`);
}

// Parse the judge's decision list into decisions by 1-based pair number. [LAW:no-silent-failure] A response
// that carries neither shape, or that omits a pair, aborts loudly (with the raw text) rather than silently
// treating the missing pair as a no-match — a missing decision is a judge failure, not a verdict.
function parseJudgeResponse(text, batchLen) {
  const arr = extractDecisionList(text);
  const byI = new Map();
  for (const item of arr) {
    if (!item || !Number.isInteger(item.i) || typeof item.match !== 'boolean') {
      throw new Error(`Judge response item is malformed (need {i:int, match:bool}): ${JSON.stringify(item)}`);
    }
    byI.set(item.i, { match: item.match, reason: typeof item.reason === 'string' ? item.reason : '' });
  }
  const decisions = [];
  for (let k = 1; k <= batchLen; k++) {
    const d = byI.get(k);
    if (!d) throw new Error(`Judge omitted a decision for pair ${k} of ${batchLen}.`);
    decisions.push(d);
  }
  return decisions;
}

function loadCache(file) {
  if (!fs.existsSync(file)) return {};
  try {
    // The cache is a string→decision MAP: route it through the shared object boundary so a bad-JSON or
    // wrong-typed cache is rejected before the inland `ck in cache` lookup can crash on it. [LAW:single-enforcer]
    return parseJsonObject(fs.readFileSync(file, 'utf8'), `Judge cache ${file}`);
  } catch (e) {
    // [LAW:no-silent-failure] Both failures (bad JSON, wrong type) surface with the delete-and-rebuild
    // hint — never silently discarding prior decisions, which would also break determinism.
    throw new Error(`${e.message} Delete it to rebuild.`);
  }
}

function saveCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
}

// [LAW:effects-at-boundaries] The one impure judge: fetch + a persisted cache. Returns the same
// `judge(pairs) → Map` shape the pure core consumes, so the core can't tell it from the lexical fake.
function makeLlmJudge({ apiKey, model, cacheFile, fetchImpl, log }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const cache = loadCache(cacheFile);
  let calls = 0;
  return async (pairs) => {
    // Partition against the cache; only uncached pairs cost a request. On re-score every pair is cached,
    // so the judge is never re-consulted — that is what makes re-scoring deterministic. [LAW:one-source-of-truth]
    const uncached = [];
    for (const p of pairs) {
      const ck = judgeCacheKey(model, p.expectedBody, p.producedBody);
      if (!(ck in cache)) uncached.push({ ...p, ck });
    }
    for (let i = 0; i < uncached.length; i += JUDGE_BATCH_SIZE) {
      const batch = uncached.slice(i, i + JUDGE_BATCH_SIZE);
      const decisions = await callJudge(doFetch, apiKey, model, batch);
      for (let k = 0; k < batch.length; k++) cache[batch[k].ck] = decisions[k];
      calls++;
      saveCache(cacheFile, cache); // persist incrementally so a mid-run abort keeps earned decisions
      if (log) log(`judge: ruled on ${batch.length} pair(s) [call ${calls}]`);
    }
    const out = new Map();
    for (const p of pairs) out.set(p.key, cache[judgeCacheKey(model, p.expectedBody, p.producedBody)]);
    return out;
  };
}

// [LAW:no-silent-failure] One request to the pinned judge; a non-200 or an unparseable body aborts loudly.
async function callJudge(doFetch, apiKey, model, batch) {
  const res = await doFetch(`${JUDGE_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      // Disable the model's own chain-of-thought: the judge must emit ONLY the JSON array. Left on, the
      // reasoning-heavy flash model spends the whole token budget thinking and returns no text block at
      // all (extractText then aborts loudly). The prompt already carries the discrimination rules, so the
      // reasoning that matters is in the instruction, not a hidden scratchpad. [LAW:no-silent-failure]
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: buildJudgePrompt(batch) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Judge request failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  // [LAW:no-silent-failure] A 200 with a non-JSON body (a proxy/gateway HTML page, a truncated response)
  // makes res.json() throw a bare `Unexpected token <` with no hint of the source. Name the judge as the
  // failure point, exactly as the non-200 arm and extractText/parseJudgeResponse do.
  let envelope;
  try {
    envelope = await res.json();
  } catch (e) {
    throw new Error(`Judge response was HTTP ${res.status} but not valid JSON (a proxy/gateway page?): ${e.message}`);
  }
  return parseJudgeResponse(extractText(envelope), batch.length);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// main (effects)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// THE definition of a completed run: a directory under the case-out root that carries a findings.json.
// A run dir that never got that far (the engine threw, the token walled) is absent from this list rather
// than counted as an empty review — which is why a crashed replay leaves debris the scorer ignores instead
// of a zero-finding run that would silently drag a baseline down. [LAW:no-silent-failure]
// Sorted so the scorecard summary lists runs deterministically. Missing dir ⇒ no runs: an absence, not an
// error, because the suite runner (freeze-suite.js) censuses cases that have not been replayed yet.
// [LAW:one-source-of-truth] Exported, so "what counts as a run" is stated once and the planner that
// decides how many more to run cannot drift from the scorer that reduces them.
function listRunDirs(caseOutDir) {
  if (!fs.existsSync(caseOutDir)) return [];
  return fs.readdirSync(caseOutDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(caseOutDir, e.name))
    .filter(d => fs.existsSync(path.join(d, 'findings.json')))
    .sort();
}

// [LAW:parse-dont-validate] The scorer's checkpoint over the same census: what it returns is a run list
// PROVEN non-empty, so nothing downstream re-checks. An empty result is a loud error here, not an empty
// scorecard — a case-out dir with no runs means the runner never wrote anything to score.
function findRunDirs(caseOutDir) {
  if (!fs.existsSync(caseOutDir)) throw new Error(`Case-out dir not found: ${caseOutDir}. Run eval/run-case.js first.`);
  const entries = listRunDirs(caseOutDir);
  if (entries.length === 0) throw new Error(`No run dirs (dirs with findings.json) under ${caseOutDir}. Run eval/run-case.js first.`);
  return entries;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const caseOutDir = path.resolve(opts.caseOutDir);
  const runDirs = findRunDirs(caseOutDir);

  // The label THIS run will record — computed once, from the single shared producer, so it can never drift
  // from the format the pre-spend check in compare.js expects. [LAW:one-source-of-truth]
  const label = matcherLabel(opts.matcher);

  // Build the semantic judge once, shared across every run so its cache accumulates. The lexical judge is
  // pure; the llm judge demands the credential up front and aborts loudly if it's absent (rather than
  // failing mid-scoring on the first request). [LAW:parse-dont-validate]
  let judge;
  if (opts.matcher === 'lexical') {
    judge = makeLexicalJudge();
  } else {
    const apiKey = requireLlmJudgeCredential();
    judge = makeLlmJudge({
      apiKey, model: JUDGE_MODEL, cacheFile: path.resolve(opts.cache),
      log: msg => process.stderr.write(`${msg}\n`),
    });
  }

  const scorecards = [];
  let caseName = null;
  for (const runDir of runDirs) {
    const meta = parseMeta(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'), path.join(runDir, 'meta.json'));
    if (caseName === null) caseName = meta.case;
    // [LAW:no-silent-failure] Every run under one case-out dir must be the same case — a mismatch means the
    // dir was assembled wrong, and averaging across cases would be a silently meaningless number.
    if (meta.case !== caseName) throw new Error(`Run ${runDir} is case '${meta.case}' but earlier runs are '${caseName}'. A case-out dir holds one case.`);

    const expectedPath = path.join(path.resolve(opts.casesDir), meta.case, 'expected.json');
    if (!fs.existsSync(expectedPath)) throw new Error(`No expected.json for case '${meta.case}' at ${expectedPath} (set --cases-dir?).`);
    const expected = parseExpected(fs.readFileSync(expectedPath, 'utf8'), expectedPath);
    const produced = parseProduced(fs.readFileSync(path.join(runDir, 'findings.json'), 'utf8'), path.join(runDir, 'findings.json'));
    const usage = fs.existsSync(path.join(runDir, 'usage.json'))
      ? parseUsage(fs.readFileSync(path.join(runDir, 'usage.json'), 'utf8'), path.join(runDir, 'usage.json'))
      : { tokens: null, span: null, cost: null };

    process.stderr.write(`Scoring ${path.basename(runDir)} (${produced.length} finding(s))…\n`);
    const scorecard = await scoreRun({ expected, produced, usage, meta, judge, matcherLabel: label });
    fs.writeFileSync(path.join(runDir, 'scorecard.json'), JSON.stringify(scorecard, null, 2) + '\n');
    scorecards.push(scorecard);
  }

  const summary = aggregateRuns(caseName, scorecards);
  fs.writeFileSync(path.join(caseOutDir, 'scorecard-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write('\n' + renderTable(summary) + '\n');
  process.stdout.write(`\nWrote scorecard.json per run and scorecard-summary.json → ${caseOutDir}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`score: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs, parseJson, parseJsonObject, parseExpected, parseProduced, parseUsage, parseMeta,
  normalizeBody, pairCandidates, computeMetrics, scoreRun, aggregateRuns, renderTable,
  makeLexicalJudge, jaccard, wordSet,
  judgeCacheKey, buildJudgePrompt, parseJudgeResponse, extractText, makeLlmJudge, callJudge, loadCache,
  // The one definition of "a completed run" — the suite runner's census and this scorer's reduction read
  // the same predicate, so neither can drift into counting a crashed replay. [LAW:one-source-of-truth]
  listRunDirs,
  // The single place ANTHROPIC_API_KEY is read for the 'llm' matcher — compare.js's pre-loop guard calls
  // this to check "would scoring succeed" before any replay spend, without a second copy of the env var
  // name. [LAW:one-source-of-truth]
  requireLlmJudgeCredential,
  // The pinned judge model. Since `matcherLabel` below became the single producer of the 'llm/<model>'
  // label format, compare.js no longer needs this directly (it gets the label through matcherLabel); this
  // stays exported for the test suite, which asserts against the exact model name in expected strings.
  JUDGE_MODEL,
  // The single producer of the label FORMAT itself (not just the model name) — compare.js's
  // expectedMatcherLabel is an alias of this, not a second copy of the template. [LAW:one-source-of-truth]
  matcherLabel,
};
