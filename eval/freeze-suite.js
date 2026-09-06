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
//   node eval/freeze-suite.js -n 5 --out eval/out/freeze-<sha> [--cases a,b,…] [--credentials VAR1,VAR2,…]
//
// It is also the gate's replay step: eval/compare.js spawns this command over the baseline's case set
// (--cases) so a gate run and a freeze are one scheduler, not a serial loop beside a parallel one.
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
  --cases <a,b,…>          Names of the golden cases to replay (default: every case under --cases-dir).
                           A name no case carries is refused before any spend.
  --job-timeout <minutes>  Deadline for ONE replay (default: 120). A replay past it is killed, process
                           group and all, and recorded as a failure. Set it wide: a deadline that kills
                           an honest replay destroys work, while a late one only wastes a lane.
  --credentials <A,B,…>    Names of env vars holding one credential each. One LANE per name, run
                           concurrently; each lane replays jobs sequentially. Default: a single lane
                           reading the suite provider's own credential input.
  --help                   Show this help.

Every case must pin the same engine — the rule eval/baseline.js enforces on the resulting suite, applied
here before any spend. A failed replay goes back on the queue and its lane moves on, attempting each job
at most once, so a walled credential costs one fast pass and a dead case costs one attempt; the command
exits non-zero naming what is still missing.
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// pure
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;
// Node stores a timer delay in a signed 32-bit int; anything larger is not clamped to the maximum but
// wrapped to ~1ms. The bound this imposes on --job-timeout is enforced in parseArgs.
const MAX_TIMER_MS = 2147483647;

// [LAW:effects-at-boundaries] Pure arg parse: flags map to a plain options value; no IO. Mirrors
// run-case.js's parser, including its `--flag looks-like-another-flag` refusal. [LAW:one-source-of-truth]
function parseArgs(argv) {
  const opts = { repeats: 5, out: 'eval/out', casesDir: 'eval/cases', cases: null, credentials: null, jobTimeout: 120 };
  const keyFor = { repeats: 'repeats', out: 'out', 'cases-dir': 'casesDir', cases: 'cases', credentials: 'credentials', 'job-timeout': 'jobTimeout' };
  const aliases = { n: 'repeats' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('-')) throw new Error(`Unexpected positional argument: ${arg} (this command takes options only).`);
    const eq = arg.indexOf('=');
    const rawName = arg.startsWith('--') ? arg.slice(2, eq === -1 ? undefined : eq) : arg.slice(1, eq === -1 ? undefined : eq);
    // Resolved before it is used for anything, so the lookup and both error messages name the same
    // spelling. Reported as the alias, `-n` renders "Option --n requires a value." — a flag that does
    // not exist, sending the reader to find it. run-case.js's parser resolves first for this reason.
    const canonical = aliases[rawName] || rawName;
    const name = keyFor[canonical];
    if (!name) throw new Error(`Unknown option: ${arg.slice(0, eq === -1 ? undefined : eq)}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${canonical} requires a value.`);
    if (eq === -1 && value.startsWith('--')) throw new Error(`Option --${canonical} requires a value, but got what looks like another flag: ${JSON.stringify(value)}.`);
    // [LAW:parse-dont-validate] Every option value crosses here, so the empty string is refused once
    // rather than per-option. `--out=` is the one that bites: path.resolve('') is the CWD, so the suite
    // reports every case at 0 completed (nothing lives under <cwd>/<case-name>), replays the whole
    // suite it already has, and writes case-named dirs into whatever directory it was invoked from.
    if (value === '') throw new Error(`Option --${canonical} requires a non-empty value.`);
    opts[name] = value;
  }
  opts.repeats = parsePositiveInt(opts.repeats, '-n/--repeats');
  opts.jobTimeout = parsePositiveInt(opts.jobTimeout, '--job-timeout');
  // A delay past Node's 32-bit ceiling does not wait longer — setTimeout fires it on the next tick. So
  // `--job-timeout 100000`, reaching for "no meaningful limit", would kill every replay within ~1ms and
  // report each one TIMED OUT: the operator's intent inverted, in a report that blames the replays.
  // Refused here, while the value is still an option and not yet a timer. [LAW:no-silent-failure]
  if (opts.jobTimeout * MS_PER_MINUTE > MAX_TIMER_MS) {
    throw new Error(
      `--job-timeout must be at most ${Math.floor(MAX_TIMER_MS / MS_PER_MINUTE)} minutes ` +
      `(a longer delay overflows setTimeout and fires immediately); got ${opts.jobTimeout}.`,
    );
  }
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

// [LAW:parse-dont-validate] A comma list of case NAMES in, the census entries that carry them out — in
// census order, so the level-filling plan below is the same plan whichever way the operator spelled the
// list. A name no case carries is the operator's typo (or a case the golden set no longer holds), and a
// suite that silently replays the others has spent hours proving less than it was asked to; refused
// here, before any spend. [LAW:no-silent-failure] The comma split is exact because a case name cannot
// carry one — run-case.js's parseCaseManifest refuses it, the one place a name is parsed.
function selectCases(cases, names) {
  const wanted = names.map(raw => raw.trim());
  for (const name of wanted) {
    if (name === '') throw new Error(`--cases contains an empty name: ${JSON.stringify(names.join(','))}.`);
    if (!cases.some(c => c.name === name)) {
      throw new Error(`--cases names '${name}', but no golden case carries that name (have: ${cases.map(c => c.name).join(', ')}).`);
    }
  }
  return cases.filter(c => wanted.includes(c.name));
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
//
// `outDir` is threaded in rather than left implicit because the closing hint names a command the operator
// is meant to paste: baseline.js's --out-dir defaults to plain `eval/out`, so a hint printed without it
// sends a suite run under --out to score a different directory. Derived from the path this run used, it
// cannot disagree with it. [LAW:one-source-of-truth]
function renderReport({ jobs, census, repeats, elapsedMs, outDir }) {
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
      ? `SUITE COMPLETE at N=${repeats} in ${outDir}: every case has ${repeats} scorable run(s).`
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
  const { PROVIDERS, providerSpec } = require('../src/provider');
  // [LAW:one-source-of-truth] `providerSpec`, not `PROVIDERS[provider]`: an alias is a provider name,
  // and run-case.js's own resolution accepts one. Looking the row up directly here made this a second,
  // alias-blind copy that refused a pin — even on a pure status re-invocation that spends nothing —
  // which the very same pin replays fine through resolveProviderConfig.
  const spec = providerSpec(provider);
  if (!spec) throw new Error(`Cases pin provider '${provider}', which src/provider.js does not define. Known: ${Object.keys(PROVIDERS).join(', ')}.`);
  return spec.credentialInput;
}

// SIGTERM first so run-case.js's own cleanup can run, SIGKILL after a grace period for a tree that
// ignores it. Signalling the negative pid is the process GROUP. A group that has already exited raises
// ESRCH — that is the race resolving in our favour, not an error to report. Module-scope because the
// deadline and the operator's Ctrl-C both need it and two definitions of "signal a group" is one too many.
const signalGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } };

// How long a tree gets to honour SIGTERM before SIGKILL. A default, not a constant a caller must accept:
// runReplay takes it as a parameter so the escalation can be asserted in a test without waiting it out.
const KILL_GRACE_MS = 20000;

// How often the interrupt path re-checks whether the trees it signalled have gone. Short enough that an
// obedient tree costs the operator no perceptible wait, long enough not to spin.
const DRAIN_POLL_MS = 50;

// [LAW:one-source-of-truth] An interrupt escalates exactly as a deadline does — SIGTERM, then SIGKILL to
// whatever is still alive KILL_GRACE_MS later. "A tree that ignores SIGTERM" is a case this file already
// treats as real, with its own escalation in superviseSpawn and a test that exercises it; a fire-and-
// forget SIGTERM here would leave running precisely the worker that ignores signals, which is the one
// this path exists to catch. Leaves as soon as the registry drains, so the obedient case waits on nothing.
// [LAW:effects-at-boundaries] signal/exit/killGraceMs are parameters so the escalation is assertable
// without sending real signals to real process groups.
function shutdownInFlight({ groups, signal, killGraceMs, exit }) {
  for (const pid of groups) signal(pid, 'SIGTERM');
  const escalate = setTimeout(() => {
    clearInterval(drained);
    for (const pid of groups) signal(pid, 'SIGKILL');
    exit();
  }, killGraceMs);
  const drained = setInterval(() => {
    if (groups.size > 0) return;
    clearTimeout(escalate);
    clearInterval(drained);
    exit();
  }, DRAIN_POLL_MS);
}

// [LAW:no-shared-mutable-globals] The set of replays running right now is one fact with exactly one
// writer — runReplay, across its own spawn/close lifecycle — and one other reader, the interrupt handler
// main() installs. It has to exist somewhere both can see: `detached` (below) puts every replay outside
// this process's group, so a Ctrl-C the terminal delivers reaches this parent and nothing else, and
// without a list there is nothing to forward it to. Add on spawn, remove when the child ends; that is
// the whole API.
const inFlight = new Set();

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
// [LAW:decomposition] Supervising a child under a deadline and DECIDING WHAT TO REPLAY are two jobs, and
// they were one function. Fused, the supervision could only ever be exercised by really replaying a
// golden case through a real engine, which is to say never — so the deadline, the escalation, and the
// timer cleanup shipped untested through two review rounds. Split at the joint, the supervision is
// generic over any child and the replay above is the argv that names one.
// [LAW:effects-at-boundaries] `signal` and `killGraceMs` are parameters for the same reason `replay` is
// one in runLane: killing a process group and waiting out a grace period are the two effects this
// function owns, and a test that cannot observe them cannot check that the escalation timer is cancelled
// when the child already exited — a negative about a signal 20 seconds out, otherwise only assertable by
// sleeping through it. [LAW:no-ambient-temporal-coupling]
function superviseSpawn({ command, args, cwd, env, logPath, timeoutMinutes, signal = signalGroup, killGraceMs = KILL_GRACE_MS }) {
  return new Promise(resolve => {
    const started = Date.now();
    const logStream = fs.createWriteStream(logPath);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    // [LAW:no-silent-failure] A Writable's unhandled 'error' is an uncaught exception, so a full disk or
    // a logDir yanked mid-run would take down the whole suite — every other lane's in-flight replay with
    // it — over one job's log. Reported where the operator will see it, and left to the child's own exit
    // to decide the job's outcome: a replay that succeeds is not a failure because its log could not be
    // written, and one that fails already reports itself.
    logStream.on('error', err => process.stderr.write(`freeze-suite: could not write ${logPath}: ${err.message}\n`));
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    inFlight.add(child.pid);

    let timedOut = false;
    const signalThisGroup = sig => signal(child.pid, sig);
    // Both timers are cleared by whichever handler ends this replay. The escalation timer especially:
    // a tree that honours SIGTERM exits at once, and an uncancelled SIGKILL still fires 20s later —
    // long enough for the OS to have reissued that pid to a process this suite never spawned. The
    // suite is normally still replaying, so `.unref()` does not save us; the process is alive and the
    // timer runs. A signal's blast radius belongs to the spawn that armed it.
    // [LAW:no-ambient-temporal-coupling]
    let escalation = null;
    const finish = () => { clearTimeout(deadline); clearTimeout(escalation); inFlight.delete(child.pid); };
    const deadline = setTimeout(() => {
      timedOut = true;
      logStream.write(`\nfreeze-suite: replay exceeded its ${timeoutMinutes}m deadline — killing the process group.\n`);
      signalThisGroup('SIGTERM');
      escalation = setTimeout(() => signalThisGroup('SIGKILL'), killGraceMs);
      escalation.unref();
    }, timeoutMinutes * MS_PER_MINUTE);

    child.on('error', err => {
      finish();
      logStream.end(`\nfreeze-suite: could not spawn the replay: ${err.message}\n`);
      resolve({ exitCode: -1, signal: null, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (exitCode, closeSignal) => {
      finish();
      logStream.end();
      resolve({ exitCode, signal: closeSignal, timedOut, durationMs: Date.now() - started });
    });
  });
}

// [LAW:decomposition] [LAW:effects-at-boundaries] Pure: the argv, working directory and environment that
// ONE replay is. Separated from the spawn because putting THIS lane's credential in the slot the pinned
// provider reads is the security-relevant half of this file, and it inherited process.env — so a wrong
// key does not fail, it silently replays on whatever credential the parent happened to be holding. A
// mapping only a real spawn can observe is a mapping nothing asserts.
function replaySpawnSpec({ job, lane, credentialInput, outRoot }) {
  return {
    command: process.execPath,
    args: [path.join(__dirname, 'run-case.js'), job.dir, '-n', '1', '--out', outRoot],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, [credentialInput]: lane.value },
  };
}

// [LAW:decomposition] One job: hand the supervision the command a replay is. Everything about surviving
// it — the deadline, the process group, the log — belongs to superviseSpawn above.
function runReplay({ job, lane, credentialInput, outRoot, logPath, timeoutMinutes }) {
  return superviseSpawn({ ...replaySpawnSpec({ job, lane, credentialInput, outRoot }), logPath, timeoutMinutes });
}

// A lane replays one job at a time and takes the first queued job it has NOT already failed, requeueing
// a failure to the BACK. That single rule gives both behaviours the suite needs, with no branch on how
// many lanes are running:
//
//   - A credential at its usage wall fails every job instantly, so the lane crosses the queue once in
//     seconds — not hours — requeues everything, finds nothing left it hasn't attempted, and exits.
//     Healthy lanes keep draining the work it put back.
//   - A job failing for its own sake (a dead case, one corrupt repo.tar.gz, the stochastic
//     `Prompt is too long` on links-317) costs one attempt and the rest of the suite still runs.
//
// Stopping the lane outright on any failure gave the first behaviour and lost the second: under the
// documented single-lane invocation it ended the only lane, so one transient failure abandoned every
// other case, and a reproducible one re-aborted every future run at the same job — the suite could never
// complete. `attempted` holds the job objects themselves, which planJobs creates once and the queue
// requeues by reference, so a lane's memory of what it tried cannot drift from what it took.
// [LAW:one-source-of-truth] [LAW:no-silent-failure]
// [LAW:no-ambient-temporal-coupling] A lane may only leave when the queue holds nothing it has not
// attempted AND no peer is mid-replay — because a peer mid-replay is the only thing that can still put a
// job back. Leaving on the queue alone made the suite's work depend on completion ORDER: two lanes, two
// jobs, lane A succeeds while B is still running, A sees the queue empty and goes; B's job then fails,
// requeues to a lane that has already attempted it, and the job ends the run with one attempt across a
// two-lane suite. Nothing was lost — the census reports the case short and the runner exits non-zero —
// but "healthy lanes keep draining" was true only when the timing happened to allow it, and a guarantee
// that holds by luck is not one. The rendezvous makes it hold by construction.
//
// It cannot deadlock: a waiter is only created while a peer is running, and every replay resolves (its
// deadline guarantees that), and the lane that decrements the count to zero wakes everyone still waiting.
function makeLaneGroup() {
  let running = 0;
  let stopped = false;
  let waiters = [];
  const wakeAll = () => { const woken = waiters; waiters = []; woken.forEach(wake => wake()); };
  return {
    // Held from the moment a lane takes a job until it has finished putting a failure BACK — not merely
    // for the replay. Waking peers at the end of the replay instead would wake them into the window
    // between "this job failed" and "this job is back in the queue", where the queue looks final and is not.
    async holding(fn) {
      running++;
      try {
        return await fn();
      } finally {
        running--;
        wakeAll();
      }
    },
    // [LAW:dataflow-not-control-flow] An interrupt is a fact about the whole group, not about any one
    // lane, and signalling the groups already in flight was only half of acting on it: the lanes went on
    // taking jobs and spawning FRESH replays for the entire escalation window, each one a new charge
    // against a real credential, started after the operator asked to stop and killed before it could
    // finish. Once stopped, the queue looks empty and no peer looks live — the two values runLane already
    // decides on — so every lane leaves through the path it already had and the stop adds no branch.
    stop() { stopped = true; wakeAll(); },
    get stopped() { return stopped; },
    // true: a peer finished, so the queue may have grown — look again. false: nobody else is running,
    // so the queue is final and this lane is genuinely done.
    peerStillRunning() {
      if (stopped || running === 0) return Promise.resolve(false);
      return new Promise(resolve => waiters.push(() => resolve(true)));
    },
  };
}

// `replay` is a parameter, not a direct call to runReplay: the rule above — which job a lane takes next,
// and what a failure costs the rest of the queue — is the whole reason this function exists, and it can
// only be checked by a test that decides which replays fail. Spawning is the one effect here; taking it
// as an argument leaves the scheduling pure enough to assert on. [LAW:effects-at-boundaries]
async function runLane({ lane, queue, credentialInput, outRoot, logDir, done, log, timeoutMinutes, replay, group }) {
  const attempted = new Set();
  for (;;) {
    const next = group.stopped ? -1 : queue.findIndex(job => !attempted.has(job));
    if (next === -1) {
      if (await group.peerStillRunning()) continue;
      return;
    }
    const [job] = queue.splice(next, 1);
    await group.holding(async () => {
      const logPath = path.join(logDir, `${job.name}-level${job.level}-${lane.name}.log`);
      log(`[${lane.name}] ${job.name} level ${job.level} — replaying…`);
      const result = await replay({ job, lane, credentialInput, outRoot, logPath, timeoutMinutes });
      const outcome = outcomeLabel({ ...result, timeoutMinutes });
      const ok = outcome === 'ok';
      done.push({ ...job, lane: lane.name, ok, outcome, durationMs: result.durationMs, log: path.relative(process.cwd(), logPath) });
      log(`[${lane.name}] ${job.name} level ${job.level} — ${ok ? 'ok' : `${outcome}, see ${logPath}`} in ${formatDuration(result.durationMs)}`);
      if (!ok) {
        attempted.add(job);
        queue.push(job);
      }
    });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  const outRoot = path.resolve(opts.out);
  const golden = censusCases(discoverCaseDirs(path.resolve(opts.casesDir)), outRoot);
  // The selection is unconditional; what varies is the list flowing into it, which names every golden
  // case when the operator named none. [LAW:dataflow-not-control-flow]
  const cases = selectCases(golden, (opts.cases ?? golden.map(c => c.name).join(',')).split(','));
  const pin = suitePin(cases);
  const credentialInput = credentialInputFor(pin.provider);

  const jobs = planJobs({ cases, repeats: opts.repeats });
  // Lane names are derived from the planned work, so a suite already at target N resolves none and needs
  // no credential. Re-invocation is this command's only resume and its only status check — demanding a
  // credential it would never spend turned reading the census into a spend-shaped precondition. The
  // resolution itself is unconditional; what varies is the list flowing into it, which is empty when
  // there is nothing to run. [LAW:dataflow-not-control-flow]
  const laneNames = jobs.length > 0 ? (opts.credentials ?? credentialInput).split(',') : [];
  const lanes = resolveLanes(laneNames, process.env);
  const log = msg => process.stderr.write(`${msg}\n`);
  log(`Suite: ${cases.length} case(s) on ${pin.provider}/${pin.model}, target N=${opts.repeats}, ${lanes.length} lane(s) [${lanes.map(l => l.name).join(', ')}], ${opts.jobTimeout}m per replay`);
  cases.forEach(c => log(`  ${c.name}: ${c.completed}/${opts.repeats} completed`));
  log(`${jobs.length} replay(s) to run → ${outRoot}`);

  // A SIBLING of the out root, never a child: every child of the out root is a case run dir, which is
  // what lets `<out>/*/` name exactly the things score.js can score. A logs/ dir inside it broke that —
  // the documented scoring loop handed logs/ to score.js and got "No run dirs" on every freeze.
  // [LAW:decomposition]
  const logDir = `${outRoot}-logs`;
  fs.mkdirSync(logDir, { recursive: true });

  // [LAW:no-silent-failure] `detached` takes every replay out of this process's group, so a Ctrl-C the
  // terminal delivers arrives HERE and reaches no replay — and the deadline timers that would eventually
  // have killed them die with this process. A suite interrupted at hour three would leave engine workers
  // running against a subscription with nobody left to stop or report them, which is the unwatched-spend
  // failure this tool was written to make impossible. 128+signum is the shell's own convention for
  // "killed by this signal", so a wrapping script reads the interrupt as an interrupt.
  const SIGNUM = { SIGINT: 2, SIGTERM: 15 };
  const group = makeLaneGroup();
  for (const sig of Object.keys(SIGNUM)) {
    process.on(sig, () => {
      log(`freeze-suite: ${sig} — signalling ${inFlight.size} in-flight replay(s) before exiting.`);
      // Before the signalling, not after: a lane that takes one more job in between starts a replay this
      // handler has already walked past, and nothing will ever signal it.
      group.stop();
      shutdownInFlight({
        groups: inFlight,
        signal: signalGroup,
        killGraceMs: KILL_GRACE_MS,
        exit: () => process.exit(128 + SIGNUM[sig]),
      });
    });
  }

  const queue = jobs.slice();
  const done = [];
  const started = Date.now();
  await Promise.all(lanes.map(lane => runLane({ lane, queue, credentialInput, outRoot, logDir, done, log, timeoutMinutes: opts.jobTimeout, replay: runReplay, group })));

  // The closing census is re-read from disk, never inferred from the job results: what the scorer will
  // find is the only fact that matters, and a job that exited 0 without leaving a run dir must show up
  // as a case still short. [FRAMING:representation]
  const census = censusCases(cases.map(c => c.dir), outRoot);
  const outDir = path.relative(process.cwd(), outRoot) || '.';
  process.stdout.write(renderReport({ jobs: done, census, repeats: opts.repeats, elapsedMs: Date.now() - started, outDir }));
  if (census.some(c => c.completed < opts.repeats)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`freeze-suite: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parsePositiveInt, resolveLanes, selectCases, suitePin, planJobs, runLane, makeLaneGroup, shutdownInFlight, runReplay, replaySpawnSpec, superviseSpawn, censusCases, credentialInputFor, renderReport, formatDuration, outcomeLabel, inFlight, KILL_GRACE_MS };
