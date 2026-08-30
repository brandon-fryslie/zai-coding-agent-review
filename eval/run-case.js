#!/usr/bin/env node
'use strict';
// Replay a FROZEN eval case (eval/cases/<name>/, produced by eval/freeze-case.sh) through the REAL
// review engine — same prompts, same multi-scope pass, same collector — with NO GitHub, so a measured
// difference between two engine versions is attributable to the code change under test and never to a
// second review implementation drifting. [LAW:one-source-of-truth]
//
// It drives the exact seams scripts/local-review.js already drives — synthesizeProviderConfig (config),
// parseUnifiedDiff (diff), buildPrMaterial + runMultiScope (the SAME adaptive scout→workers engine
// production runs). Nothing about config, diffs, prompts, or the pass is reimplemented here; this file
// is an INSTRUMENT that arranges frozen inputs and captures outputs, not a review. [LAW:decomposition]
//
// A case is frozen inputs (repo tree + saved diff + a pinned engine); the only variance left at replay
// time is the model's own stochasticity, which is why -n runs the case repeatedly and each run's
// artifacts land in their own append-only dir for a downstream scorer/baseline to reduce.
//
//   node eval/run-case.js <case-dir> [-n <repeats>] [--out <dir>] [--workers <N>]
//
// The provider credential is read from the same env var the action uses (CLAUDE_CODE_OAUTH_TOKEN /
// DEEPSEEK_API_KEY / ZAI_API_KEY / OPENAI_API_KEY, selected by the case's pinned provider — the
// mapping is src/provider.js's, not a copy). See --help.
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib + pure helpers. Every world-effect
// (temp dirs, env mutation, tar, IO) and every engine-stack require lives inside main(), the entry
// boundary — so importing this file for the pure-helper tests performs no IO and loads no engine stack.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const USAGE = `Replay a frozen eval case through the real review engine (no GitHub) and leave per-run
artifacts (findings.json, summary.txt, usage.json, transcripts/) for the scorer to reduce.

Usage: node eval/run-case.js <case-dir> [options]

  <case-dir>          Path to a frozen case directory (e.g. eval/cases/cc-candybar-150-transcript-perf).
  -n, --repeats <N>   Number of times to replay the case (default: 1). Each run gets its own dir.
  --out <dir>         Output root (default: eval/out). Artifacts go under <out>/<case>/<ts>-run<i>/.
  --workers <N>       Max concurrent scope workers (default: 4).
  --help              Show this help.

The engine (provider/model/reasoning) is PINNED by case.json and cannot be overridden here — a replay
on a different model would corrupt any baseline comparison, so a mismatch is refused loudly.
`;

// [LAW:effects-at-boundaries] Pure arg parse: flags + one required positional map to a plain options
// value; no IO. `--flag value` and `--flag=value` both supported; `-n` is the one short alias.
function parseArgs(argv) {
  const opts = { caseDir: null, repeats: 1, out: 'eval/out', workers: 4 };
  const known = new Set(['repeats', 'out', 'workers']);
  const aliases = { n: 'repeats' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('-')) {
      if (opts.caseDir !== null) throw new Error(`Unexpected second positional argument: ${arg} (only <case-dir> is positional).`);
      opts.caseDir = arg;
      continue;
    }
    const eq = arg.indexOf('=');
    const rawName = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : arg.slice(1, eq === -1 ? undefined : eq);
    const name = aliases[rawName] || rawName;
    if (!known.has(name)) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${name} requires a value.`);
    // [LAW:no-silent-failure] A space-separated value that is itself a long option (starts with `--`)
    // is a missing value, not a directory literally named '--workers=2'; consuming it would silently
    // swallow the next flag and drop the user's intent. `--` is the exact discriminator — a negative
    // number like `-1` (single dash) is NOT caught here, so it still reaches its own validator
    // (parsePositiveInt) for the accurate "positive integer" error. The `=` form is explicit, so honored.
    if (eq === -1 && value.startsWith('--')) throw new Error(`Option --${name} requires a value, but got what looks like another flag: ${JSON.stringify(value)}.`);
    opts[name] = value;
  }
  if (opts.caseDir === null) throw new Error('Missing required <case-dir> argument. See --help.');
  // [LAW:parse-dont-validate] The counts leave this parser as integers, not strings — a bad value is
  // rejected here, at the boundary, so no downstream code re-checks. parsePositiveInt rejects
  // non-integers outright rather than truncating (a baseline comparison depends on the EXACT repeat count).
  opts.repeats = parsePositiveInt(opts.repeats, '-n/--repeats');
  opts.workers = parsePositiveInt(opts.workers, '--workers');
  return opts;
}

// [LAW:parse-dont-validate] Parse a CLI flag as a positive integer — the accept set is exactly
// {1,2,3,…}. Number() + Number.isInteger rejects '2.5'/'3.7'/'abc' where parseInt would SILENTLY
// TRUNCATE ('2.5' → 2), so the check finally matches the "positive integer" the error promises.
// [LAW:no-silent-failure] The rejected value is echoed so a typo is located, not guessed.
function parsePositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer (got ${JSON.stringify(raw)}).`);
  return n;
}

// [LAW:parse-dont-validate] Parse the raw case.json into a validated manifest — a value whose existence
// proves every field the runner consumes is present and well-typed, so nothing downstream re-checks.
// [LAW:no-silent-failure] A missing/malformed field aborts here naming the exact field, never later as
// a confusing engine error on a half-formed input. Paths are resolved against caseDir so a consumer
// holds absolute paths, not relative fragments it must re-join. `expected` is NOT required here: the
// replay does not read it (the scorer, 2fk.3, does), so requiring it would couple this runner to a
// concern it doesn't own.
function parseCaseManifest(raw, caseDir) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`case.json in ${caseDir} is not valid JSON: ${e.message}`);
  }
  const req = (v, name) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`case.json (${caseDir}) is missing a valid string '${name}'.`);
    return v;
  };
  const name = req(json.name, 'name');
  // [LAW:parse-dont-validate] name is used as a single path COMPONENT (path.join(caseOutRoot, name) and
  // meta.json provenance), so parse it as one: a name with a separator or `..` would write output
  // outside eval/out/ or nest it unexpectedly while meta.json still records the raw name. Reject any
  // non-plain-component name here so it can never reach path.join. [LAW:no-silent-failure]
  if (name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error(`case.json (${caseDir}) 'name' must be a plain directory component (no path separators or '..'), got ${JSON.stringify(name)}.`);
  }
  const diff = req(json.diff, 'diff');
  const tree = req(json.tree, 'tree');
  const engine = json.engine;
  if (!engine || typeof engine !== 'object') throw new Error(`case.json (${caseDir}) is missing an 'engine' object.`);
  req(engine.provider, 'engine.provider');
  req(engine.model, 'engine.model');
  // reasoning is genuinely optional in the domain (deepseek carries none); normalize absent → null so
  // the pin check compares one representation of "no reasoning", never undefined-vs-null. [LAW:one-source-of-truth]
  const reasoning = engine.reasoning ?? null;
  // [LAW:parse-dont-validate] reasoning is null OR a non-empty tier string. An empty string is neither —
  // left unrejected it slips past a bare typeof check, then buildProviderInputs coerces it to undefined
  // and the pin check reports a confusing "Reasoning-pin mismatch" instead of the real problem. Reject it
  // here, at the boundary, exactly as `req` rejects an empty provider/model. [LAW:no-silent-failure]
  if (reasoning !== null && (typeof reasoning !== 'string' || reasoning.trim() === '')) {
    throw new Error(`case.json (${caseDir}) 'engine.reasoning' must be null or a non-empty string.`);
  }
  const excludePatterns = json.excludePatterns ?? [];
  if (!Array.isArray(excludePatterns)) throw new Error(`case.json (${caseDir}) 'excludePatterns' must be an array.`);
  return {
    name,
    diffPath: path.join(caseDir, diff),
    treePath: path.join(caseDir, tree),
    engine: { provider: engine.provider, model: engine.model, reasoning },
    excludePatterns,
  };
}

// [LAW:parse-dont-validate] THE checkpoint a replay's engine config crosses: a pinned engine plus an
// environment go in, and what comes out is a ReviewConfig *proven* to match the pin — so no caller can
// hold an unverified one. Resolution itself is delegated to src/provider.js's resolveProviderConfig,
// the one seam that owns which env var and which input key each provider's credential and model travel
// under. [LAW:one-source-of-truth] This file used to hand-build that input bag, and the hand-built copy
// listed only openai/zai/deepseek keys — so when 1.42.0 retargeted `auto` to claude-subscription, the
// harness measuring review quality was structurally unable to run the provider production runs on. The
// bag is not rebuilt here at any price; that is the whole defect.
// [LAW:effects-at-boundaries] env is a parameter, not a read of process.env, so this stays testable.
function resolvePinnedConfig(engine, env, reg) {
  const { resolveProviderConfig } = require('../src/provider');
  return assertConfigMatchesPin(
    resolveProviderConfig({ provider: engine.provider, model: engine.model, reasoning: engine.reasoning || undefined, env }, reg),
    engine,
  );
}

// [LAW:no-silent-failure] The pin comparison itself. A drift (the provider default moved, or the pin
// names a model/reasoning the provider can't carry) is refused loudly, naming both values, because a
// replay on anything but the pinned engine corrupts baseline comparison.
function assertConfigMatchesPin(config, engine) {
  if (config.model !== engine.model) {
    throw new Error(
      `Model-pin mismatch: case pins '${engine.model}' but the resolved config is '${config.model}'. ` +
      `A replay on a different model corrupts baseline comparison — refusing.`,
    );
  }
  const pinReasoning = engine.reasoning ?? null;
  const gotReasoning = config.reasoning ?? null;
  if (gotReasoning !== pinReasoning) {
    throw new Error(
      `Reasoning-pin mismatch: case pins ${JSON.stringify(pinReasoning)} but the resolved config is ` +
      `${JSON.stringify(gotReasoning)} — refusing.`,
    );
  }
  return config;
}

// [LAW:effects-at-boundaries] Pure: the append-only run directory name. One invocation timestamp fixes
// the batch; the run index disambiguates the N repeats within it. A second invocation carries a new
// timestamp, so it can never collide with a prior batch's dirs. [LAW:no-silent-failure]
function runDirName(timestamp, i) {
  return `${timestamp}-run${i}`;
}

// The effectful helpers below lazily require their src deps, so importing this module never loads the
// engine stack — only main() (or a helper it calls) does, after the run boundary is established.

// [LAW:no-silent-failure] Extract the frozen tree, validating the external tar call: the tarball must
// exist, tar must succeed (execFileSync throws on non-zero), and the result must be non-empty. A case
// whose tree is gone or empty is DEAD and must say so, never silently review the wrong (empty) tree.
function extractTree(treePath, destDir) {
  if (!fs.existsSync(treePath)) {
    throw new Error(`Case tree not found: ${treePath}. The case is unreplayable — re-freeze it or remove it.`);
  }
  execFileSync('tar', ['-xzf', treePath, '-C', destDir]);
  if (fs.readdirSync(destDir).length === 0) {
    throw new Error(`Case tree ${treePath} extracted to an empty directory — the tarball is corrupt.`);
  }
}

function loadDiffFiles(diffPath) {
  const { parseUnifiedDiff, parseReviewableFiles } = require('../src/diff');
  const { files: parsed, warnings } = parseUnifiedDiff(fs.readFileSync(diffPath, 'utf8'));
  warnings.forEach(w => console.warn(w));
  // The same boundary production crosses in selectTransport, and scripts/local-review.js with it. This
  // harness is the instrument the recall/precision baselines are MEASURED on, so a file set it reviews
  // but production refuses would make every number it reports a measurement of a different review.
  // [LAW:single-enforcer]
  const { files, unreviewable } = parseReviewableFiles(parsed);
  unreviewable.forEach(u => console.warn(`Skipping ${u.filename} from the review: ${u.reason}.`));
  if (files.length === 0) {
    throw new Error(`No reviewable changed files parsed from ${diffPath}. The frozen diff is empty, malformed, or names only unreviewable paths.`);
  }
  return files;
}

// [LAW:decomposition] One job: turn a frozen case's raw changed files into the material a replay runs on
// — the case-side mirror of run.js's fetch → filter → buildPrMaterial path. It lived inline in main()'s
// replay body, which no test executes, so when filterFiles' return shape changed the wiring broke in
// silence and a green suite hid it. Extracted so the wiring HAS a contract a test can hold.
// [LAW:one-source-of-truth] Filtering runs through production's own filterFiles seam, in the SAME order
// run.js does. The freezer saves the RAW three-dot diff and stores the patterns separately, so an
// unfiltered replay would review files the original review's EXCLUDE_PATTERNS stripped — a superset that
// corrupts the measured verdict. `excluded` rides on to buildPrMaterial for the mirror-image reason: the
// production material CONFESSES what those patterns removed, so a replay that dropped it would score the
// reviewer against a prompt production never sends — the instrument measuring the wrong thing.
// [LAW:effects-at-boundaries] Pure: it computes and throws. The caller owns the stderr line, composed
// from the `excluded` returned here.
function buildCaseMaterial({ allFiles, excludePatterns, reviewedRepoRoot }) {
  const { filterFiles } = require('../src/diff');
  const { buildPrMaterial } = require('../src/multiscope');
  const { reviewed: files, excluded } = filterFiles(allFiles, excludePatterns);
  // [LAW:no-silent-failure] Every changed file excluded means there is nothing to review — a case that
  // would replay as a vacuous empty review must say so, not quietly produce a zero-finding artifact.
  if (files.length === 0) {
    throw new Error(`All ${allFiles.length} changed file(s) were excluded by the case's EXCLUDE_PATTERNS — nothing to review.`);
  }
  // maxDiffChars: 0 (no truncation) exactly as scripts/local-review.js does — the frozen diff is the whole
  // material the workers see, anchored against the same (filtered) files.
  return { files, excluded, material: buildPrMaterial({ files, maxDiffChars: 0, reviewedRepoRoot, excluded }) };
}

// [LAW:no-ambient-temporal-coupling] Drain the engine's frozen TRANSCRIPT_DIR into this run's dir, then
// leave it empty for the next run. TRANSCRIPT_DIR is a module-load constant in src/debug.js (bound to
// RUNNER_TEMP at first require), so it cannot be re-pointed per run; instead the loop owns the ordering —
// each sequential run's transcripts are moved out AFTER its pass resolves and BEFORE the next begins, so
// same-named transcripts (scout.txt, scope '…'.txt) across runs never clobber. copy+unlink (not rename)
// so it works when TRANSCRIPT_DIR and the out dir are on different filesystems.
function drainTranscripts(transcriptDir, destDir) {
  if (!fs.existsSync(transcriptDir)) return [];
  const names = fs.readdirSync(transcriptDir).filter(f => f.endsWith('.txt'));
  if (names.length === 0) return [];
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    fs.copyFileSync(path.join(transcriptDir, name), path.join(destDir, name));
    fs.rmSync(path.join(transcriptDir, name));
  }
  return names;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const caseDir = path.resolve(opts.caseDir);
  const caseJsonPath = path.join(caseDir, 'case.json');
  if (!fs.existsSync(caseJsonPath)) {
    throw new Error(`No case.json at ${caseJsonPath}. Point <case-dir> at a frozen case directory (eval/cases/<name>).`);
  }
  const manifest = parseCaseManifest(fs.readFileSync(caseJsonPath, 'utf8'), caseDir);

  // [LAW:no-ambient-temporal-coupling] main owns the ordering, and this is the load-bearing step: point
  // RUNNER_TEMP at a fresh staging dir BEFORE requiring ANY src module. src/debug.js binds TRANSCRIPT_DIR
  // to RUNNER_TEMP at first require, and the provider require below transitively loads it (provider →
  // engine adapters → debug), so resolving the config first would freeze TRANSCRIPT_DIR against the wrong
  // (un-redirected) tmpdir and every run's transcripts would escape this loop's drain.
  const stagingTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-run-case-'));
  process.env.RUNNER_TEMP = stagingTemp;
  const treeTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-tree-'));
  try {
    // [LAW:parse-dont-validate] Resolve + verify the pinned config before any expensive work, so a missing
    // credential (thrown by synthesizeProviderConfig, naming the input) or a model-pin mismatch reds the run
    // immediately. The src requires inside are lazy (not at module load) so importing this file for the
    // pure-helper tests loads no engine stack; RUNNER_TEMP is already set above, so debug's TRANSCRIPT_DIR
    // is correct.
    const config = resolvePinnedConfig(manifest.engine, process.env);
    const { TRANSCRIPT_DIR } = require('../src/debug');
    const { runMultiScope } = require('../src/multiscope');
    const { defaultEffortProfile } = require('../src/effort');
    const registry = require('../src/engine/registry');
    const instructionsPath = path.join(__dirname, '..', 'review-agent', 'instructions.md');

    // The extracted tree is REVIEWED_REPO_ROOT: the engine reads scope files by absolute path under it,
    // and the diff (from change.diff) supplies the anchors. The tarball unpacks at root (no wrapper dir),
    // so destDir itself is the repo root.
    extractTree(manifest.treePath, treeTemp);
    const allFiles = loadDiffFiles(manifest.diffPath);
    const { files, excluded, material } = buildCaseMaterial({
      allFiles, excludePatterns: manifest.excludePatterns, reviewedRepoRoot: treeTemp,
    });
    if (excluded.paths.length > 0) process.stderr.write(`Excluded ${excluded.paths.length} file(s) matching the case's EXCLUDE_PATTERNS: ${excluded.paths.join(', ')}\n`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const caseOutRoot = path.join(path.resolve(opts.out), manifest.name);
    fs.mkdirSync(caseOutRoot, { recursive: true });

    process.stderr.write(
      `Replaying case '${manifest.name}' ${opts.repeats}× on ${config.name} (${config.model}) over ${files.length} file(s)…\n`,
    );

    const runDirs = [];
    for (let i = 1; i <= opts.repeats; i++) {
      const runDir = path.join(caseOutRoot, runDirName(timestamp, i));
      // [LAW:no-silent-failure] Append-only is a verified invariant, not a hope: a pre-existing run dir
      // (only possible via a same-millisecond re-run) aborts rather than clobbering prior artifacts.
      if (fs.existsSync(runDir)) throw new Error(`Run directory already exists (refusing to clobber): ${runDir}`);
      fs.mkdirSync(runDir, { recursive: true });

      process.stderr.write(`[run ${i}/${opts.repeats}] reviewing…\n`);
      const { review } = await runMultiScope({
        chain: [config], material, registry, instructionsPath,
        effort: { ...defaultEffortProfile(), scopeConcurrency: opts.workers },
        log: msg => process.stderr.write(`[run ${i}] ${msg}\n`),
      });

      // The raw merged findings from runMultiScope — path/line/body/severity, PRE anchor-partition (the
      // PR sink's partitionFindings is deliberately NOT applied here; the scorer matches against the
      // frozen diff itself). [LAW:one-source-of-truth]
      fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(review.findings, null, 2) + '\n');
      fs.writeFileSync(path.join(runDir, 'summary.txt'), (review.summary || '') + '\n');
      fs.writeFileSync(path.join(runDir, 'usage.json'), JSON.stringify(review.usage, null, 2) + '\n');
      // Provenance the scorer/baseline read instead of re-deriving from the dir name. [LAW:one-source-of-truth]
      fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
        case: manifest.name, timestamp, run: i, repeats: opts.repeats, workers: opts.workers,
        config: { name: config.name, engine: config.engine, model: config.model, reasoning: config.reasoning ?? null },
        findingCount: review.findings.length,
      }, null, 2) + '\n');
      const transcripts = drainTranscripts(TRANSCRIPT_DIR, path.join(runDir, 'transcripts'));

      process.stderr.write(`[run ${i}/${opts.repeats}] ${review.findings.length} finding(s), ${transcripts.length} transcript(s) → ${runDir}\n`);
      runDirs.push(runDir);
    }

    process.stdout.write(`\nReplayed '${manifest.name}' ${opts.repeats}× → ${caseOutRoot}\n`);
    runDirs.forEach(d => process.stdout.write(`  ${d}\n`));
  } finally {
    // [LAW:effects-at-boundaries] Reproducible scratch (the extracted tree and the transcript staging
    // dir) is cleaned; the artifacts under eval/out persist. Cleanup runs even when a run throws, so a
    // failed replay leaves no temp litter — but leaves the loud error and any completed runs' artifacts.
    fs.rmSync(treeTemp, { recursive: true, force: true });
    fs.rmSync(stagingTemp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`run-case: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parseCaseManifest, resolvePinnedConfig, assertConfigMatchesPin, runDirName, buildCaseMaterial };
