#!/usr/bin/env node
'use strict';
// Replay the WHOLE golden suite N times per case — the `run` step of the freeze workflow
// (run → score → freeze) as one resumable, credential-parallel command.
//
// It reimplements no part of a replay: every job is `node eval/run-case.js <case-dir> -n 1 --out <out>`,
// the same instrument, in its own process. [LAW:one-source-of-truth] What this file owns is the
// SCHEDULE — which replays are still missing, and which credential runs each one.
//
// Why it exists: the documented workflow was a bare shell loop, and a suite is ~20 replays over several
// hours against a subscription that walls for hours at a time. The loop had no census (a walled token
// produced empty run dirs that nobody noticed for five days), no way to resume, and no way to spend more
// than one account's quota. [LAW:no-silent-failure]
//
// The plan is LEVEL-FILLING: a job exists for case c at level r iff c has fewer than r completed runs. So
// the suite deepens EVERY case before it deepens any one of them, and a freeze interrupted at level 3
// degrades to a valid N=3 suite (baseline.js demands one common N across cases) instead of a lopsided
// 5/5/5/0 that freezes nothing. Re-running the command resumes by re-taking the census — there is no
// resume flag because there is no resume mode. [LAW:dataflow-not-control-flow]
//
//   node eval/freeze-suite.js -n 5 --out eval/out/freeze-<sha> [--credentials VAR1,VAR2,…]
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib. Every world-effect (fs, spawn, env reads)
// lives inside main() or a helper it calls, so importing this file for the planner tests touches nothing.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const USAGE = `Replay every golden case N times into one output root, resumably, across one or more credentials.

Usage: node eval/freeze-suite.js [options]

  -n, --repeats <N>        Target completed runs per case (default: 5 — the standing baseline depth).
  --out <dir>              Output root shared by every case (default: eval/out). Re-runs resume into it.
  --cases-dir <dir>        Golden case root (default: eval/cases).
  --job-timeout <minutes>  Deadline for ONE replay (default: 120). A replay past it is killed, process
                           group and all, and recorded as a failure. Set it wide: a deadline that kills
                           an honest replay destroys work, while a late one only wastes a lane.
  --credentials <A,B,…>    Names of env vars holding one credential each. One LANE per name, run
                           concurrently; each lane replays jobs sequentially. Default: a single lane
                           reading the suite provider's own credential input.
  --help                   Show this help.

Every case must pin the same engine — the rule eval/baseline.js enforces on the resulting suite, applied
here before any spend. A lane stops at its first failed replay (a walled credential fails every job it is
handed); the other lanes carry on, and the command exits non-zero naming what is still missing.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// pure
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:effects-at-boundaries] Pure arg parse: flags map to a plain options value; no IO. Mirrors
// run-case.js's parser, including its `--flag looks-like-another-flag` refusal. [LAW:one-source-of-truth]
function parseArgs(argv) {
  const opts = { repeats: 5, out: 'eval/out', casesDir: 'eval/cases', credentials: null, jobTimeout: 120 };
  const keyFor = { repeats: 'repeats', out: 'out', 'cases-dir': 'casesDir', credentials: 'credentials', 'job-timeout': 'jobTimeout' };
  const aliases = { n: 'repeats' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('-')) throw new Error(`Unexpected positional argument: ${arg} (this command takes options only).`);
    const eq = arg.indexOf('=');
    const rawName = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : arg.slice(1, eq === -1 ? undefined : eq);
    const name = keyFor[aliases[rawName] || rawName] || keyFor[rawName];
    if (!name) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${rawName} requires a value.`);
    if (eq === -1 && value.startsWith('--')) throw new Error(`Option --${rawName} requires a value, but got what looks like another flag: ${JSON.stringify(value)}.`);
    opts[name] = value;
  }
  opts.repeats = parsePositiveInt(opts.repeats, '-n/--repeats');
  opts.jobTimeout = parsePositiveInt(opts.jobTimeout, '--job-timeout');
  return opts;
}

function parsePositiveInt(value, label) {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a positive integer (got ${JSON.stringify(value)}).`);
  return n;
}

// [LAW:parse-dont-validate] A comma list of env var NAMES in, a lane list with its VALUES already read
// out — so no lane downstream holds an unresolved or empty credential. A named-but-unset var is the
// operator's typo, and spending three hours discovering it one job at a time is the failure this refuses.
// [LAW:no-silent-failure] A repeated name is refused too: two lanes on one account is a lie about
// capacity that walls twice as fast for no gain.
function resolveLanes(names, env) {
  const lanes = names.map(raw => {
    const name = raw.trim();
    if (name === '') throw new Error(`--credentials contains an empty name: ${JSON.stringify(names.join(','))}.`);
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`--credentials names '${name}', but that environment variable is unset or empty.`);
    }
    return { name, value };
  });
  const seen = new Set();
  for (const lane of lanes) {
    if (seen.has(lane.name)) throw new Error(`--credentials names '${lane.name}' more than once — one lane per credential.`);
    seen.add(lane.name);
  }
  return lanes;
}

// [LAW:parse-dont-validate] The suite's engine pin: one engine out, or a loud refusal. This is the SAME
// theorem eval/baseline.js states over the scored summaries (`sameEngine`) — asserted here, before the
// spend, rather than after four hours of it. [LAW:single-enforcer] is not violated: baseline.js still
// enforces it over what was actually scored; this is the same rule applied to the plan.
function suitePin(cases) {
  if (cases.length === 0) throw new Error('No golden cases found — nothing to replay.');
  const pin = cases[0].engine;
  for (const c of cases) {
    if (c.engine.provider !== pin.provider || c.engine.model !== pin.model || (c.engine.reasoning ?? null) !== (pin.reasoning ?? null)) {
      throw new Error(
        `Case '${c.name}' pins ${JSON.stringify(c.engine)} but '${cases[0].name}' pins ${JSON.stringify(pin)} — ` +
        `a baseline needs one engine, so a suite run does too.`,
      );
    }
  }
  return pin;
}

// [LAW:effects-at-boundaries] Pure: the census and the target go in, the ordered job list comes out.
// A job exists for case c at level r iff c has fewer than r completed runs — so the deficit per case is
// exact, and the ORDER fills level 1 for every case before level 2 for any, which is what makes an
// interrupted suite a smaller valid suite rather than a ruined one.
function planJobs({ cases, repeats }) {
  const jobs = [];
  for (let level = 1; level <= repeats; level++) {
    for (const c of cases) {
      if (c.completed < level) jobs.push({ name: c.name, dir: c.dir, level });
    }
  }
  return jobs;
}

// [LAW:parse-dont-validate] The three ways a replay can end, collapsed into the one label every reader
// (the live log line and the closing table) shows. A kill is NOT reported as an ordinary non-zero exit:
// a deadline that expired and an engine that refused are different diagnoses with different fixes, and a
// label that merged them would send the operator to the wrong one. [LAW:no-silent-failure]
function outcomeLabel({ exitCode, signal, timedOut, timeoutMinutes }) {
  if (timedOut) return `TIMED OUT (killed after ${timeoutMinutes}m)`;
  if (signal) return `KILLED (${signal})`;
  return exitCode === 0 ? 'ok' : `FAILED (exit ${exitCode})`;
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

// [LAW:effects-at-boundaries] Pure: the finished job records and the closing census render the report the
// caller prints. Every job appears — a suite that spent four hours must be able to say where every hour
// went, and which log holds the failure. [LAW:no-silent-failure]
function renderReport({ jobs, census, repeats, elapsedMs }) {
  const lines = [];
  lines.push('', `Suite: ${jobs.length} replay(s) attempted in ${formatDuration(elapsedMs)}`, '');
  lines.push('| level | case | lane | result | time | log |');
  lines.push('|-------|------|------|--------|------|-----|');
  for (const j of jobs) {
    lines.push(`| ${j.level} | ${j.name} | ${j.lane} | ${j.outcome} | ${formatDuration(j.durationMs)} | ${j.log} |`);
  }
  lines.push('', '| case | completed | target |', '|------|-----------|--------|');
  for (const c of census) lines.push(`| ${c.name} | ${c.completed} | ${repeats} |`);
  const usableN = census.reduce((min, c) => Math.min(min, c.completed), Infinity);
  lines.push('');
  lines.push(
    usableN >= repeats
      ? `SUITE COMPLETE at N=${repeats}. Next: score each case, then node eval/baseline.js.`
      : `SUITE SHORT of N=${repeats}. Every case has at least ${usableN} run(s), so the deepest freezable suite today is N=${usableN}. Re-run this command to fill the rest.`,
  );
  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// effects
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] The census reads score.js's `listRunDirs` — the one definition of a completed
// run (a dir carrying findings.json). A private copy here is how the planner would come to disagree with
// the scorer about how many runs a case has.
function censusCases(caseDirs, outRoot) {
  const { parseCaseManifest } = require('./run-case');
  const { listRunDirs } = require('./score');
  return caseDirs.map(dir => {
    const manifest = parseCaseManifest(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'), dir);
    return {
      name: manifest.name,
      dir,
      engine: manifest.engine,
      completed: listRunDirs(path.join(outRoot, manifest.name)).length,
    };
  });
}

function discoverCaseDirs(casesDir) {
  if (!fs.existsSync(casesDir)) throw new Error(`Cases dir not found: ${casesDir}.`);
  const dirs = fs.readdirSync(casesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(casesDir, e.name))
    .filter(d => fs.existsSync(path.join(d, 'case.json')))
    .sort();
  if (dirs.length === 0) throw new Error(`No golden cases (dirs with case.json) under ${casesDir}.`);
  return dirs;
}

// [LAW:one-source-of-truth] Which env var a provider's credential travels under is src/provider.js's fact,
// derived here exactly as freeze-case.sh derives the default engine pin. A literal cannot notice a retarget.
function credentialInputFor(provider) {
  const { PROVIDERS } = require('../src/provider');
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Cases pin provider '${provider}', which src/provider.js does not define. Known: ${Object.keys(PROVIDERS).join(', ')}.`);
  return spec.credentialInput;
}

// One replay, in its own process, with this lane's credential in the slot the pinned provider reads. The
// child's whole output is kept — a failure's cause is in it, and a four-hour suite must not make the
// operator reproduce a failure to see it. [LAW:no-silent-failure]
//
// [LAW:no-ambient-temporal-coupling] The replay has a DEADLINE, owned here. A walled or throttled
// credential does not always FAIL: the engine CLI can sit in silent retry indefinitely, and one lane
// waiting on it holds the queue forever — a stall is the wall's worst shape precisely because nothing
// reports it. "It finishes eventually" was a property nothing guaranteed, so it is made one. The default
// is deliberately loose (observed replays run 16–60 minutes on the largest cases): a deadline that kills
// an honest replay destroys an hour of real work, while one that fires late only idles a lane.
//
// `detached` makes the replay its own process-group leader so the deadline can take down the WHOLE tree.
// The engine spawns four claude-code workers per pass; signalling only the direct child would orphan them
// to keep burning quota against a parent that is already gone.
function runReplay({ job, lane, credentialInput, outRoot, logPath, timeoutMinutes }) {
  return new Promise(resolve => {
    const started = Date.now();
    const logStream = fs.createWriteStream(logPath);
    const child = spawn(process.execPath, [path.join(__dirname, 'run-case.js'), job.dir, '-n', '1', '--out', outRoot], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, [credentialInput]: lane.value },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });

    let timedOut = false;
    // SIGTERM first so run-case.js's own cleanup can run, SIGKILL after a grace period for a tree that
    // ignores it. Signalling the negative pid is the process GROUP. A group that has already exited
    // raises ESRCH — that is the race resolving in our favour, not an error to report.
    const signalGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const deadline = setTimeout(() => {
      timedOut = true;
      logStream.write(`\nfreeze-suite: replay exceeded its ${timeoutMinutes}m deadline — killing the process group.\n`);
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 20000).unref();
    }, timeoutMinutes * 60 * 1000);

    child.on('error', err => {
      clearTimeout(deadline);
      logStream.end(`\nfreeze-suite: could not spawn the replay: ${err.message}\n`);
      resolve({ exitCode: -1, signal: null, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(deadline);
      logStream.end();
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started });
    });
  });
}

// A lane replays its jobs one at a time and STOPS at its first failure, returning the failed job to the
// BACK of the queue. A credential that has hit its usage wall fails every job it is handed, instantly, so
// a lane that carries on would burn the whole queue in minutes and report twenty identical failures; a
// lane that swallowed the job would lose it while healthy lanes idled. Requeued at the back, the job is
// retried by whichever lane is still working once the other work is done — and a job that is failing for
// its own sake (a dead case, not a walled token) costs at most one attempt per lane, then the queue drains
// and every failure is in the report with its log. [LAW:no-silent-failure]
async function runLane({ lane, queue, credentialInput, outRoot, logDir, done, log, timeoutMinutes }) {
  while (queue.length > 0) {
    const job = queue.shift();
    const logPath = path.join(logDir, `${job.name}-level${job.level}-${lane.name}.log`);
    log(`[${lane.name}] ${job.name} level ${job.level} — replaying…`);
    const result = await runReplay({ job, lane, credentialInput, outRoot, logPath, timeoutMinutes });
    const outcome = outcomeLabel({ ...result, timeoutMinutes });
    const ok = outcome === 'ok';
    done.push({ ...job, lane: lane.name, ok, outcome, durationMs: result.durationMs, log: path.relative(process.cwd(), logPath) });
    log(`[${lane.name}] ${job.name} level ${job.level} — ${ok ? 'ok' : `${outcome}, see ${logPath}`} in ${formatDuration(result.durationMs)}`);
    if (!ok) {
      queue.push(job);
      return;
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const outRoot = path.resolve(opts.out);
  const cases = censusCases(discoverCaseDirs(path.resolve(opts.casesDir)), outRoot);
  const pin = suitePin(cases);
  const credentialInput = credentialInputFor(pin.provider);
  const laneNames = (opts.credentials ?? credentialInput).split(',');
  const lanes = resolveLanes(laneNames, process.env);

  const jobs = planJobs({ cases, repeats: opts.repeats });
  const log = msg => process.stderr.write(`${msg}\n`);
  log(`Suite: ${cases.length} case(s) on ${pin.provider}/${pin.model}, target N=${opts.repeats}, ${lanes.length} lane(s) [${lanes.map(l => l.name).join(', ')}], ${opts.jobTimeout}m per replay`);
  cases.forEach(c => log(`  ${c.name}: ${c.completed}/${opts.repeats} completed`));
  log(`${jobs.length} replay(s) to run → ${outRoot}`);

  const logDir = path.join(outRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const queue = jobs.slice();
  const done = [];
  const started = Date.now();
  await Promise.all(lanes.map(lane => runLane({ lane, queue, credentialInput, outRoot, logDir, done, log, timeoutMinutes: opts.jobTimeout })));

  // The closing census is re-read from disk, never inferred from the job results: what the scorer will
  // find is the only fact that matters, and a job that exited 0 without leaving a run dir must show up
  // as a case still short. [FRAMING:representation]
  const census = censusCases(cases.map(c => c.dir), outRoot);
  process.stdout.write(renderReport({ jobs: done, census, repeats: opts.repeats, elapsedMs: Date.now() - started }));
  if (census.some(c => c.completed < opts.repeats)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`freeze-suite: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parsePositiveInt, resolveLanes, suitePin, planJobs, renderReport, formatDuration, outcomeLabel };
