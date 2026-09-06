'use strict';
const { spawn } = require('child_process');
const readline = require('readline');
const core = require('@actions/core');
const { emitTranscript } = require('../debug');
const { DeadlineExceededError, BUDGET_REMEDY, remainingMs } = require('../deadline');

// [LAW:no-ambient-temporal-coupling] An engine may legitimately emit an arbitrarily large
// stream — codex's app-server streams every reasoning delta and tool call as a JSON-RPC line,
// so a dense, law-comment-heavy diff easily produces many megabytes. What we RETAIN is bounded
// to a trailing window so memory stays flat on a big review; the engine is NOT killed for being
// verbose. "The process never terminates" is owned by the per-invocation timeout below — never
// by output volume. A stdin engine's session reads this retained tail back, and the events it
// needs (the terminal result envelope and the usage riding it) are the LAST emitted, so the tail
// preserves exactly them; a session that reads the stream LIVE (codex's app-server conversation —
// see promptOnStdin) is never clipped at all.
const MAX_RETAINED_OUTPUT = 8 * 1024 * 1024;

// [LAW:one-type-per-behavior] stdout and stderr are the same behavior — captured child output
// bounded to a trailing window. Append, then clip to the last MAX_RETAINED_OUTPUT bytes. A clip
// can sever the first retained line mid-JSON; every consumer parses line-by-line and skips
// unparseable lines, so a severed leading fragment is harmlessly dropped. `clipped` reports
// whether bytes were dropped, so the caller can announce the information loss rather than let a
// stream-summed usage silently undercount. [LAW:no-silent-failure]
// [LAW:dataflow-not-control-flow] The retention window is a VALUE, not a hardcoded constant: `max`
// defaults to the production cap but is overridable, so the boundary behavior (append, clip, report)
// can be exercised at any window size — a tiny cap in tests, the real 8 MiB in production — without
// pushing megabytes through a pipe just to cross the threshold.
function appendBounded(buffer, chunk, max = MAX_RETAINED_OUTPUT) {
  const next = buffer + chunk;
  if (next.length > max) return { text: next.slice(-max), clipped: true };
  return { text: next, clipped: false };
}

// [LAW:no-shared-mutable-globals] The live-engine-group registry, owned by THIS module with one
// invariant: a pid is present exactly while its detached spawn is unsettled (added at spawn,
// removed in finish). It exists for one consumer — the shutdown reaper — because detaching an
// engine into its own process group (so a deadline kill can signal the whole tree) also removes it
// from the ACTION's group: if the action dies first (workflow cancel, TIME_BUDGET_MINUTES 0, a
// budget above the job's timeout-minutes), a group-based job kill no longer reaches the engine and
// it can orphan on a persistent self-hosted/act_runner host, burning provider credits. The reaper
// SIGKILLs every live group on process 'exit' and on SIGINT/SIGTERM (re-exiting with the
// conventional code), so the engine dies with the action on every path the action can observe.
// GitHub-hosted runners additionally evaporate the VM at job end — the reaper is what closes the
// self-hosted gap. ESRCH is the goal state, never an error.
const liveEngineGroups = new Set();
function reapLiveEngineGroups() {
  for (const pid of liveEngineGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ESRCH: already gone — the goal state */ }
  }
  liveEngineGroups.clear();
}
let reaperInstalled = false;
function installShutdownReaper() {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on('exit', reapLiveEngineGroups);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      reapLiveEngineGroups();
      process.exit(code);
    });
  }
}

function parseJsonEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const trimmed = stdout.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return undefined;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return undefined;
    }
  }
}

function formatOutputTail(label, value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return `${label}: <empty>`;
  }
  return `${label}:\n${trimmed.slice(-4000)}`;
}

// [LAW:one-type-per-behavior] THE SESSION is how an engine is talked to — the one primitive that
// differs between a CLI that takes its prompt on stdin and prints until it exits (claude-code,
// opencode) and a server that holds a JSON-RPC conversation over the same two pipes (codex's
// app-server). Each spec names its session as a VALUE and runEngine drives whichever it is handed
// through the one lifecycle below. A session receives `io` — write/end on the child's stdin,
// `lines` (a readline over its stdout: every line as it arrives, never clipped) and `closed` (a
// promise of the retained stdout, settled once the child has exited and released its pipes) — and
// resolves with the engine's OUTPUT VALUE, the thing the spec's assertSucceeded and extractUsage
// read. [LAW:dataflow-not-control-flow] runEngine never asks which kind of engine it is running;
// the session is a value that flows through the same spawn, capture, timeout and settle.
//
// promptOnStdin is the stdin-engine session: deliver the prompt, wait for the exit, and the output
// is the retained stdout — exactly what those adapters parsed before the session existed as a seam.
function promptOnStdin(io, prompt) {
  io.end(prompt);
  return io.closed;
}

// [LAW:decomposition] Generic spawn runner: owns timeout, size-cap, and process lifecycle.
// All engine-specific logic (args, env, session, success check, error classification) lives in the
// adapter. Resolves with { output, span }: the session's output value (the retained stdout for a
// stdin engine, the protocol record for a server engine) so the caller can extract usage/cost from
// it, and the spawn's wall-clock span ({ from, to }, ISO-8601 UTC) stamped by this module's own
// clock — the one owner of the child's lifetime (zai-timing-31d.4).
// [LAW:no-ambient-temporal-coupling] The per-invocation timeout is owned here, not in callers.
// [LAW:effects-at-boundaries] This is the only place that spawns a child process.
// cwd is the engine's working directory — an isolated scratch dir outside the reviewed repo tree
// (see cli.js) so no repo-committed project-instruction file is auto-loaded as reviewer directives.
//
// [LAW:single-enforcer] `deadline` (epoch ms, null = no budget) is the review's wall-clock budget,
// and this is the ONE place it bounds a spawn's lifetime: the effective timeout is the smaller of
// the adapter's own sanity cap and the time remaining. The two bounds mean different things and
// throw different types [LAW:types-are-the-program] — the adapter cap firing is an engine failure
// (plain Error, as before), the deadline firing is planned degradation (DeadlineExceededError, which
// the scope-worker pool absorbs as "scope unreviewed" instead of failing the pass). A deadline
// already in the past refuses to spawn at all — the one enforcer of "no engine starts past the
// budget", so callers never race a doomed spawn.
function runEngine(adapter, config, prompt, home, collector, cwd, deadline = null) {
  return new Promise((resolve, reject) => {
    const remaining = remainingMs(deadline, Date.now());
    if (remaining <= 0) {
      reject(new DeadlineExceededError(
        `${adapter.name} spawn refused: the review's time budget is exhausted. ${BUDGET_REMEDY}`,
      ));
      return;
    }
    const { command, args, env } = adapter.buildCommand({ config, collector, home });
    const adapterCapMs = adapter.timeoutMs ?? 3_000_000;
    // <= : at the exact tie both bounds fire at the same instant, and the deadline reading wins —
    // it is true (the budget did expire then) and it is the safe side (absorbed upstream as an
    // unreviewed scope; the adapter-cap reading would take the batch-aborting plain-Error path).
    const deadlineBound = remaining <= adapterCapMs;
    const timeoutMs = deadlineBound ? remaining : adapterCapMs;
    // [LAW:dataflow-not-control-flow] The retention window is the adapter's value (default 8 MiB),
    // mirroring the timeoutMs seam above — so a test can exercise the clip/announce path at a small cap.
    const maxRetained = adapter.maxRetainedOutput ?? MAX_RETAINED_OUTPUT;
    // detached puts the child in its OWN process group (POSIX), so a kill can signal the whole tree.
    // The engines here are npx/CLI launchers whose real work happens in a GRANDCHILD: signalling only
    // the direct child leaves the engine alive — writing its temp HOME while the caller's cleanup
    // deletes it (the live ENOTEMPTY crash that red a run and discarded its findings), holding the
    // stdio pipes so the action lingered 15 minutes past its own deadline, and burning provider
    // credits as an orphan. Group delivery is what makes a kill mean the TREE is gone. The TRADEOFF
    // — a detached group escapes the action's own group and would outlive an action killed first —
    // is owned by the live-group registry + shutdown reaper above, so the engine dies with the
    // action on cancel/signal paths too.
    const posix = process.platform !== 'win32';
    // [LAW:effects-at-boundaries] The spawn's clock is read HERE, in the one place that owns the
    // child's whole lifetime — started at spawn, stopped in finish(), which runs on EVERY
    // termination path. A spawn that failed after 200 seconds is the most interesting timing datum
    // there is; a clock hung off the success path would throw it away. The stamped span rides the
    // resolution as a value and every post-spawn rejection as err.span, so no outcome loses its
    // duration. [LAW:one-source-of-truth] This is the single mint of the span — the caller derives
    // the pricing instant from span.from rather than reading a second clock that could land on the
    // other side of a rate boundary.
    const startedAt = new Date();
    let span = null;
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], cwd, detached: posix });
    if (posix) {
      installShutdownReaper();
      liveEngineGroups.add(child.pid);
    }
    // Signal the whole group on POSIX (the negative-pid form), the lone child elsewhere. ESRCH means
    // the tree is already gone — the goal state, not an error; anything else is announced, never
    // thrown into the engine lifecycle. [LAW:no-silent-failure]
    const killTree = signal => {
      try {
        if (posix) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (e) {
        if (e.code !== 'ESRCH') core.warning(`${adapter.name}: failed to ${signal} the engine process tree: ${e.message}`);
      }
    };
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    // [LAW:effects-at-boundaries] The single capture point for the session transcript: this is the only
    // place that owns the child's raw streams, and finish() runs on EVERY termination path (success,
    // non-zero exit, spawn error, timeout), so a transcript is captured for every engine attempt —
    // including a failed run. The prompt (delivered on stdin, never echoed in output) is joined with
    // the raw stdout/stderr as captured so far. Capture is unconditional — there is no opt-in flag.
    // [LAW:no-silent-failure] emitTranscript swallows nothing — it warns on its own IO failures
    // internally and never throws back into the engine lifecycle.
    const finish = result => {
      if (settled) return;
      settled = true;
      // The span closes at the settle — after 'close' proved the tree exited and released the
      // pipes — so a killed spawn's duration includes the kill-to-exit tail it actually occupied.
      span = { from: startedAt.toISOString(), to: new Date().toISOString() };
      clearTimeout(timeout);
      clearTimeout(escalation);
      liveEngineGroups.delete(child.pid);
      emitTranscript({
        engine: adapter.name,
        model: config.model,
        prompt,
        stdout,
        stderr,
        label: `transcript-${config.name || adapter.name}-${process.hrtime.bigint().toString(36)}`,
      });
      result();
    };
    // [LAW:no-silent-failure] Every post-spawn rejection carries the span it burned: the duration
    // of a failed spawn is diagnostics the callers upstream may surface, and the error object is
    // the only vehicle that survives a rejection. The guarantee is per SPAWN: a retry loop that
    // re-spawns after a transient failure receives each attempt's own span, and folding those
    // attempts into a schedule is the aggregation layer's job (zai-timing-31d.5) — today
    // retryTransientSpawn reads only the attempt it settles on.
    const fail = err => {
      err.span = span;
      reject(err);
    };

    // [LAW:no-ambient-temporal-coupling] A kill SETTLES NOTHING here: the timeout only signals the
    // tree (SIGTERM, then SIGKILL after the grace for an engine that ignores the polite form) and
    // remembers that it fired; the one settle path for a killed spawn is the 'close' handler below,
    // which the OS fires only when the process tree has actually exited and released the stdio
    // pipes. That ordering is the fix for the ENOTEMPTY race: control returns to the caller — whose
    // finally deletes the engine's temp HOME — only when nothing is left alive to write into it.
    // The escalation timer must OUTLIVE finish-from-timeout (there is none anymore) and is cleared
    // in finish, i.e. when close/error actually settles: a SIGTERM that worked needs no SIGKILL.
    let timedOut = false;
    let escalation = null;
    const killGraceMs = adapter.killGraceMs ?? 2_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      escalation = setTimeout(() => killTree('SIGKILL'), killGraceMs);
    }, timeoutMs);

    // [LAW:no-silent-failure] A verbose-but-complete review must finish and be parsed, not be
    // aborted for tripping a byte ceiling — that turned every substantial review into a crash.
    // Retention is bounded (appendBounded); completion is judged by adapter.assertSucceeded on
    // close, which throws loud when the terminal event is absent. An oversized stream is never
    // laundered into a clean pass. When stdout is clipped, `truncated` records it so close can
    // announce that a stream-summed usage (e.g. OpenCode) may undercount — never a silent drop.
    child.stdout.on('data', chunk => {
      const { text, clipped } = appendBounded(stdout, chunk, maxRetained);
      stdout = text;
      truncated = truncated || clipped;
    });
    child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk, maxRetained).text; });
    // [LAW:no-silent-failure] exception: a write to a child that has already died raises EPIPE on
    // stdin, and the child's death is the fact — reported by the 'close' path below with its exit
    // code and output tails. Left unhandled it would surface as an uncaught exception naming the
    // pipe instead, so the pipe error is the one signal here that is genuinely irrelevant.
    child.stdin.on('error', () => {});

    // [LAW:no-ambient-temporal-coupling] The session reads stdout LIVE through its own readline — a
    // second reader beside the bounded capture above — so a protocol conversation, and every usage
    // notification an engine emits mid-stream, is seen whole even when the retained window later
    // clips the stream's head. `closed` settles on 'close' with the retained stdout on EVERY exit
    // path, so a session still awaiting a completion the engine never sent settles too, instead of
    // hanging past the child's death; its rejection is then the loudest cause on the settle.
    let closedResolve;
    const closed = new Promise(resolve => { closedResolve = resolve; });
    const io = {
      write: text => child.stdin.write(text),
      end: text => child.stdin.end(text),
      lines: readline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
      closed,
    };
    const session = Promise.resolve().then(() => adapter.session(io, prompt));
    // A session that fails mid-conversation closes stdin, so a server that exits on EOF (codex
    // app-server does) exits on its own; one that does not is still bounded by the timeout. The
    // rejection is remembered by the promise, never thrown here: 'close' is the one settle path.
    session.catch(() => child.stdin.end());

    child.on('error', err => {
      finish(() => fail(adapter.classifyError(err, '')));
    });

    child.on('close', code => {
      closedResolve(stdout);
      // [LAW:types-are-the-program] A close after a kill is the KILL settling, not an engine exit
      // to classify: which bound fired decides the type — the deadline kill is the budget working
      // as designed (absorbed upstream as an unreviewed scope); the adapter-cap kill is an engine
      // that outlived any sane review and stays the loud failure it always was.
      if (timedOut) {
        finish(() => {
          // One unconditional SIGKILL sweep before settling: 'close' proves the direct child and
          // every PIPE HOLDER are gone — not the whole group. A pipe-less grandchild that ignored
          // SIGTERM (stdio 'ignore'/re-detached) would otherwise be spared exactly here, when the
          // early close cancels the pending escalation, and outlive the settle into the cleanup —
          // the ENOTEMPTY/credit-burn hole again. Idempotent: ESRCH is the goal state.
          killTree('SIGKILL');
          fail(deadlineBound
            ? new DeadlineExceededError(
              `${adapter.name} spawn killed: the review's time budget ran out mid-spawn. ${BUDGET_REMEDY}`,
            )
            : new Error(`${adapter.name} review timed out.`));
        });
        return;
      }
      if (code !== 0) {
        finish(() => {
          const msg = [
            `${adapter.name} exited with status ${code}.`,
            `Command: ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`,
            formatOutputTail('stderr tail', stderr),
            formatOutputTail('stdout tail', stdout),
          ].join('\n\n');
          fail(adapter.classifyError(new Error(msg), `${stdout}\n${stderr}`));
        });
        return;
      }
      // [LAW:no-silent-failure] A clean exit settles on the SESSION's verdict: its output goes
      // through assertSucceeded exactly as the retained stdout always did, and a session that
      // failed mid-conversation — a refused request, an exit before the turn completed — is the
      // loud cause even though the process itself exited 0.
      session.then(
        output => finish(() => {
          try {
            adapter.assertSucceeded(output);
            // The trailing window holds a stdin engine's terminal event and last-event usage, and a
            // live session saw every line, so completion and their usage are exact. A stream-summed
            // usage (OpenCode adds per-event tokens/cost) loses the dropped prefix, so the loss is
            // announced here rather than reported as an exact figure.
            if (truncated) {
              core.warning(
                `${adapter.name} output exceeded the ${maxRetained} byte retention window; ` +
                'kept the trailing window. Completion and last-event usage are intact; a stream-summed ' +
                'usage/cost for this run may be a lower bound.',
              );
            }
            // [LAW:dataflow-not-control-flow] The session's output is the engine's output value; the
            // caller derives usage/cost from it via the adapter's extractUsage. Findings still flow
            // out-of-band through the MCP collector — the output carries only usage.
            resolve({ output, span });
          } catch (err) {
            fail(adapter.classifyError(err, stdout));
          }
        }),
        err => finish(() => fail(adapter.classifyError(err, `${stdout}\n${stderr}`))),
      );
    });
  });
}

module.exports = { parseJsonEnvelope, formatOutputTail, runEngine, promptOnStdin, appendBounded, reapLiveEngineGroups, MAX_RETAINED_OUTPUT };
