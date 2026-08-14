'use strict';
const { spawn } = require('child_process');
const core = require('@actions/core');
const { emitTranscript } = require('../debug');
const { DeadlineExceededError, BUDGET_REMEDY, remainingMs } = require('../deadline');

// [LAW:no-ambient-temporal-coupling] An engine may legitimately emit an arbitrarily large
// stream — codex `exec --json` streams every reasoning delta and tool call as a JSONL line,
// so a dense, law-comment-heavy diff easily produces many megabytes. What we RETAIN is bounded
// to a trailing window so memory stays flat on a big review; the engine is NOT killed for being
// verbose. "The process never terminates" is owned by the per-invocation timeout below — never
// by output volume. The events the caller needs (turn.completed / turn.failed and the cumulative
// usage that rides the terminal event) are the LAST emitted, so a tail preserves exactly them.
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

// [LAW:decomposition] Generic spawn runner: owns timeout, size-cap, and process lifecycle.
// All engine-specific logic (args, env, success check, error classification) lives in the adapter.
// Resolves with the child's captured stdout so the caller can extract usage/cost from it.
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
    const deadlineBound = remaining < adapterCapMs;
    const timeoutMs = deadlineBound ? remaining : adapterCapMs;
    // [LAW:dataflow-not-control-flow] The retention window is the adapter's value (default 8 MiB),
    // mirroring the timeoutMs seam above — so a test can exercise the clip/announce path at a small cap.
    const maxRetained = adapter.maxRetainedOutput ?? MAX_RETAINED_OUTPUT;
    // detached puts the child in its OWN process group (POSIX), so a kill can signal the whole tree.
    // The engines here are npx/CLI launchers whose real work happens in a GRANDCHILD: signalling only
    // the direct child leaves the engine alive — writing its temp HOME while the caller's cleanup
    // deletes it (the live ENOTEMPTY crash that red a run and discarded its findings), holding the
    // stdio pipes so the action lingered 15 minutes past its own deadline, and burning provider
    // credits as an orphan. Group delivery is what makes a kill mean the TREE is gone.
    const posix = process.platform !== 'win32';
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], cwd, detached: posix });
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
      clearTimeout(timeout);
      clearTimeout(escalation);
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

    child.on('error', err => {
      finish(() => reject(adapter.classifyError(err, '')));
    });

    child.on('close', code => {
      finish(() => {
        // [LAW:types-are-the-program] A close after a kill is the KILL settling, not an engine exit
        // to classify: which bound fired decides the type — the deadline kill is the budget working
        // as designed (absorbed upstream as an unreviewed scope); the adapter-cap kill is an engine
        // that outlived any sane review and stays the loud failure it always was.
        if (timedOut) {
          reject(deadlineBound
            ? new DeadlineExceededError(
              `${adapter.name} spawn killed: the review's time budget ran out mid-spawn. ${BUDGET_REMEDY}`,
            )
            : new Error(`${adapter.name} review timed out.`));
          return;
        }
        if (code !== 0) {
          const msg = [
            `${adapter.name} exited with status ${code}.`,
            `Command: ${command} ${args.map(a => JSON.stringify(a)).join(' ')}`,
            formatOutputTail('stderr tail', stderr),
            formatOutputTail('stdout tail', stdout),
          ].join('\n\n');
          reject(adapter.classifyError(new Error(msg), `${stdout}\n${stderr}`));
          return;
        }
        try {
          adapter.assertSucceeded(stdout);
          // [LAW:no-silent-failure] The trailing window holds the terminal completion event and
          // last-event usage (codex/claude), so completion and their usage are exact. A stream-
          // summed usage (OpenCode adds per-event tokens/cost) loses the dropped prefix, so the
          // loss is announced here rather than reported as an exact figure.
          if (truncated) {
            core.warning(
              `${adapter.name} output exceeded the ${maxRetained} byte retention window; ` +
              'kept the trailing window. Completion and last-event usage are intact; a stream-summed ' +
              'usage/cost for this run may be a lower bound.',
            );
          }
          // [LAW:dataflow-not-control-flow] The captured stdout is the engine's output value;
          // the caller derives usage/cost from it via the adapter's extractUsage. Findings
          // still flow out-of-band through the MCP collector — stdout carries only usage.
          resolve(stdout);
        } catch (err) {
          reject(adapter.classifyError(err, stdout));
        }
      });
    });

    child.stdin.end(prompt);
  });
}

module.exports = { parseJsonEnvelope, formatOutputTail, runEngine, appendBounded, MAX_RETAINED_OUTPUT };
