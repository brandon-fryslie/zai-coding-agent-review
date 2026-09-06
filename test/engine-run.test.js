'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('@actions/core');
const { runEngine, promptOnStdin, appendBounded } = require('../src/engine/run.js');

// A small retention window for the runEngine integration tests below. The cap is a VALUE the
// adapter supplies (src defaults to 8 MiB in production), so these tests exercise the identical
// append→clip→announce path at a tiny window — no megabytes pushed through a pipe just to cross the
// threshold, which is what made these tests take ~17 minutes each on a constrained CI runner.
const RETAIN_CAP = 4096;

// appendBounded is the single retention policy shared by stdout and stderr: append, then keep
// only the trailing `max` bytes, reporting whether it clipped. These assert the contract directly
// at a small cap (fast, pure), plus the default-cap path.
describe('appendBounded', () => {
  test('omitting max applies the production default cap (no clip on a small input)', () => {
    // deepEqual covers both the joined text and clipped:false — a small input never clips at the default cap.
    assert.deepEqual(appendBounded('foo', 'bar'), { text: 'foobar', clipped: false });
  });

  test('over the cap, retains exactly the trailing window and reports the clip', () => {
    const out = appendBounded('', 'a'.repeat(74), 64);
    assert.equal(out.text.length, 64);
    assert.equal(out.clipped, true);
  });

  test('preserves the NEWEST bytes (tail) and discards the OLDEST (head)', () => {
    // The terminal turn.completed/turn.failed events are emitted LAST, so the tail is what the
    // caller needs; an old head fragment is the safe thing to drop.
    const out = appendBounded('OLDEST_MARKER', 'b'.repeat(64), 64);
    assert.equal(out.text.length, 64);
    assert.ok(!out.text.includes('OLDEST_MARKER'));
    assert.ok(out.text.endsWith('b'));
    assert.equal(out.clipped, true);
  });
});

// Run fn with core.warning captured; restore it after. core is a shared module singleton, so the
// same instance runEngine holds is the one patched here. [LAW:effects-at-boundaries]
async function captureWarnings(fn) {
  const original = core.warning;
  const warnings = [];
  core.warning = msg => warnings.push(msg);
  try { await fn(); } finally { core.warning = original; }
  return warnings;
}

// A fake engine whose spawned process emits MORE than the retained cap of stdout, then optionally
// a terminal success line. runEngine reads only stdout (findings flow out-of-band via the
// collector elsewhere), so the collector argument is irrelevant here.
function makeAdapter({ emitTerminal }) {
  const overflow = RETAIN_CAP + 2048;
  const script =
    `const big='x'.repeat(512);` +
    `let w=0; while(w<${overflow}){process.stdout.write(big); w+=big.length;}` +
    (emitTerminal ? `process.stdout.write('\\n'+JSON.stringify({type:'turn.completed'})+'\\n');` : ``);
  return {
    name: 'fake',
    timeoutMs: 30_000,
    maxRetainedOutput: RETAIN_CAP,
    buildCommand: () => ({
      command: process.execPath,
      args: ['-e', script],
      env: { PATH: process.env.PATH },
    }),
    // Mirror the real adapters: completion is judged by the presence of the terminal event.
    session: promptOnStdin,
    assertSucceeded: stdout => {
      const completed = stdout.split('\n').some(line => {
        try { return JSON.parse(line).type === 'turn.completed'; } catch { return false; }
      });
      if (!completed) throw new Error('fake review did not complete: turn.completed not emitted.');
    },
    classifyError: err => err,
  };
}

describe('runEngine with an oversized engine stream', () => {
  // The bug this guards: a 1MB stdout ceiling killed every substantial, law-comment-dense review
  // mid-flight, so the reviewer was effectively non-functional on real PRs (slopspot-tooling-yjz).
  test('a stream larger than the retained cap that ends in a terminal success COMPLETES (not killed on size), and the truncation is announced loudly', async () => {
    let stdout;
    const warnings = await captureWarnings(async () => {
      ({ output: stdout } = await runEngine(makeAdapter({ emitTerminal: true }), {}, 'prompt', '/tmp', {}, process.cwd()));
    });
    assert.ok(stdout.length <= RETAIN_CAP, `retained ${stdout.length} exceeds cap ${RETAIN_CAP}`);
    assert.ok(stdout.includes('turn.completed'), 'the terminal event the caller needs survives in the tail');
    // [LAW:no-silent-failure] the information loss is loud, so a stream-summed usage cannot quietly undercount.
    assert.ok(warnings.some(w => /retention window/.test(w) && /lower bound/.test(w)), 'truncation warning emitted');
  });

  test('a stream UNDER the cap completes with NO truncation warning', async () => {
    const small = {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');`],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const warnings = await captureWarnings(async () => {
      await runEngine(small, {}, 'prompt', '/tmp', {}, process.cwd());
    });
    assert.equal(warnings.length, 0, 'no truncation warning when nothing was clipped');
  });

  test('an oversized stream with NO terminal success still FAILS LOUD (never laundered into a clean pass)', async () => {
    await assert.rejects(
      runEngine(makeAdapter({ emitTerminal: false }), {}, 'prompt', '/tmp', {}, process.cwd()),
      /did not complete/,
    );
  });
});

// Every engine attempt surfaces a session transcript — capture is unconditional (no opt-in flag).
// The emit lives in the shared finish() helper, so it runs once per attempt on EVERY termination
// path: the success path and the failed (non-zero exit) path are both asserted below.
describe('runEngine session transcript', () => {
  const fs = require('node:fs');
  const { TRANSCRIPT_DIR } = require('../src/debug');

  test('captures a transcript file containing the prompt with no debug flag set', async () => {
    const small = {
      name: 'claude-code',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');`],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const groups = [];
    const originalGroup = core.startGroup;
    core.startGroup = label => groups.push(label);
    const before = fs.existsSync(TRANSCRIPT_DIR) ? new Set(fs.readdirSync(TRANSCRIPT_DIR)) : new Set();
    try {
      await runEngine(small, { name: 'deepseek', model: 'deepseek-v4-pro' }, 'THE-PROMPT', '/tmp', {}, process.cwd());
    } finally {
      core.startGroup = originalGroup;
    }
    assert.ok(groups.some(g => /Session transcript/.test(g)), 'a session transcript log group was opened');
    const fresh = fs.readdirSync(TRANSCRIPT_DIR).filter(f => !before.has(f));
    assert.ok(fresh.length >= 1, 'a new transcript file was written');
    const content = fs.readFileSync(`${TRANSCRIPT_DIR}/${fresh[0]}`, 'utf8');
    assert.match(content, /THE-PROMPT/);
    assert.match(content, /turn\.completed/);
    fresh.forEach(f => fs.rmSync(`${TRANSCRIPT_DIR}/${f}`, { force: true }));
  });

  test('captures a transcript even when the attempt fails (non-zero exit)', async () => {
    const failing = {
      name: 'claude-code',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', `process.stderr.write('BOOM-STDERR'); process.exit(1);`],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const before = fs.existsSync(TRANSCRIPT_DIR) ? new Set(fs.readdirSync(TRANSCRIPT_DIR)) : new Set();
    await assert.rejects(
      runEngine(failing, { name: 'deepseek', model: 'deepseek-v4-pro' }, 'FAILED-PROMPT', '/tmp', {}, process.cwd()),
    );
    const fresh = fs.readdirSync(TRANSCRIPT_DIR).filter(f => !before.has(f));
    assert.ok(fresh.length >= 1, 'a transcript file was written for the failed attempt');
    const content = fs.readFileSync(`${TRANSCRIPT_DIR}/${fresh[0]}`, 'utf8');
    assert.match(content, /FAILED-PROMPT/);
    assert.match(content, /BOOM-STDERR/);
    fresh.forEach(f => fs.rmSync(`${TRANSCRIPT_DIR}/${f}`, { force: true }));
  });
});

// ── the wall-clock deadline at the spawn boundary (zai-timing-sn1) ────────────────────────────────
// The deadline and the adapter's own cap are DIFFERENT bounds with different types: the deadline
// firing is the time budget's planned degradation (DeadlineExceededError, absorbed upstream as an
// unreviewed scope); the adapter cap firing stays the loud engine failure it always was.
describe('runEngine under a wall-clock deadline', () => {
  const { DeadlineExceededError } = require('../src/deadline.js');

  test('a deadline already in the past refuses to spawn at all', async () => {
    let built = false;
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => { built = true; return { command: process.execPath, args: ['-e', ''], env: { PATH: process.env.PATH } }; },
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() - 1),
      (err) => err instanceof DeadlineExceededError && /TIME_BUDGET_MINUTES/.test(err.message),
    );
    assert.equal(built, false, 'no command is built for a spawn that can never run');
  });

  test('a deadline nearer than the adapter cap kills the spawn with the deadline type', async () => {
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000, // the adapter cap is far; the deadline must be the bound that fires
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000);'], // outlives the deadline
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 300),
      (err) => err instanceof DeadlineExceededError && /ran out mid-spawn/.test(err.message),
    );
  });

  test('the adapter cap firing under a FAR deadline stays the plain timeout error', async () => {
    const adapter = {
      name: 'fake',
      timeoutMs: 300, // the adapter cap is the nearer bound
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000);'],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 3_600_000),
      (err) => !(err instanceof DeadlineExceededError) && /review timed out/.test(err.message),
    );
  });
});

// ── a kill means the TREE is gone (zai-timing-sn1 round 3: the live ENOTEMPTY crash) ──────────────
// The engines are npx launchers whose real work happens in a grandchild. Signalling only the direct
// child left the engine alive — writing its temp HOME during cleanup (ENOTEMPTY, findings
// discarded), holding stdio so the action lingered past its own deadline, and burning credits as an
// orphan. The kill signals the process GROUP and settles only on 'close' — when the tree has
// actually exited and released the pipes.
describe('runEngine kill semantics', () => {
  const { DeadlineExceededError } = require('../src/deadline.js');
  const fs = require('fs');
  const os = require('os');
  const pathmod = require('path');

  test('a deadline kill takes down the whole process tree — a grandchild cannot outlive the settle', async () => {
    const pidFile = pathmod.join(os.tmpdir(), `engine-run-gpid-${process.pid}-${Date.now()}`);
    const script =
      `const { spawn } = require('child_process');` +
      `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);'], { stdio: 'ignore' });` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));` +
      `setTimeout(() => {}, 30000);`;
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => ({ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH } }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 500),
      DeadlineExceededError,
    );
    // The settle happens on 'close', i.e. after the group signal — the grandchild must already be
    // dead (or die within the SIGKILL grace at most; poll briefly to absorb signal delivery time).
    const gpid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    fs.rmSync(pidFile, { force: true });
    assert.ok(Number.isInteger(gpid) && gpid > 0, `grandchild pid recorded (${gpid})`);
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      try {
        process.kill(gpid, 0);
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        dead = e.code === 'ESRCH';
        break;
      }
    }
    assert.ok(dead, `grandchild ${gpid} is dead after the deadline kill settled`);
  });

  test('an engine that ignores SIGTERM is SIGKILLed after the grace and still settles with the deadline type', async () => {
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000,
      killGraceMs: 300,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);'],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const started = Date.now();
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 300),
      DeadlineExceededError,
    );
    // deadline (~300ms) + grace (300ms) + SIGKILL delivery — well under 5s, never the 30s the
    // SIGTERM-ignoring engine wanted.
    assert.ok(Date.now() - started < 5_000, 'the escalation ended the spawn promptly');
  });

  test('removeQuietly surfaces a failed cleanup as a warning, never a throw that outranks the result', async () => {
    const { removeQuietly } = require('../src/engine/cli.js');
    const warnings = await captureWarnings(async () => {
      removeQuietly(pathmod.join(os.tmpdir(), `engine-run-nonexistent-${Date.now()}`), 'temp HOME');
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Could not remove the engine's temp HOME/);
  });
});

// ── round 6: the two orphan holes the group-kill left open ────────────────────────────────────────
describe('runEngine orphan reaping', () => {
  const { DeadlineExceededError } = require('../src/deadline.js');
  const { reapLiveEngineGroups } = require('../src/engine/run.js');
  const fs = require('fs');
  const os = require('os');
  const pathmod = require('path');

  async function pollDead(pid) {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        return e.code === 'ESRCH';
      }
    }
    return false;
  }

  test("a pipe-less SIGTERM-ignoring grandchild dies at the settle's SIGKILL sweep, not from the pipes closing", async () => {
    const pidFile = pathmod.join(os.tmpdir(), `engine-run-straggler-${process.pid}-${Date.now()}`);
    // The direct child dies politely on SIGTERM; its stdio-ignore grandchild ignores SIGTERM — the
    // exact shape where an early 'close' used to cancel the escalation and spare the straggler.
    const script =
      `const { spawn } = require('child_process');` +
      `const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30000);'], { stdio: 'ignore' });` +
      `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));` +
      `setTimeout(() => {}, 30000);`;
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000,
      killGraceMs: 10_000, // the escalation timer alone would fire far too late to explain a dead straggler
      buildCommand: () => ({ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH } }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(
      runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 500),
      DeadlineExceededError,
    );
    const gpid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    fs.rmSync(pidFile, { force: true });
    assert.ok(await pollDead(gpid), `SIGTERM-ignoring pipe-less grandchild ${gpid} is dead after the settle`);
  });

  test('reapLiveEngineGroups kills an in-flight engine group — the shutdown path for an action dying first', async () => {
    const adapter = {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => ({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000);'],
        env: { PATH: process.env.PATH },
      }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    const inFlight = runEngine(adapter, {}, 'p', '/tmp', {}, process.cwd(), null);
    await new Promise(r => setTimeout(r, 200)); // let the spawn register its group
    reapLiveEngineGroups();
    await assert.rejects(inFlight); // SIGKILLed → nonzero close → the loud engine-failure path
  });
});

// ── every spawn reports its own duration (zai-timing-31d.4) ───────────────────────────────────────
// The span is stamped in finish(), the one helper that runs on EVERY termination path — so a spawn
// that FAILED after burning real time still reports what it burned. Success carries it on the
// resolved value; every post-spawn rejection carries it as err.span. [LAW:no-silent-failure]
describe('runEngine spawn duration', () => {
  const { DeadlineExceededError } = require('../src/deadline.js');

  const durationOf = span => Date.parse(span.to) - Date.parse(span.from);

  function sleeperAdapter(script, extra = {}) {
    return {
      name: 'fake',
      timeoutMs: 30_000,
      buildCommand: () => ({ command: process.execPath, args: ['-e', script], env: { PATH: process.env.PATH } }),
      session: promptOnStdin,
      assertSucceeded: () => {},
      classifyError: err => err,
      ...extra,
    };
  }

  test('a successful spawn resolves with a span whose duration brackets the time it actually slept', async () => {
    const before = Date.now();
    const { span } = await runEngine(
      sleeperAdapter(`setTimeout(() => process.stdout.write('{"type":"turn.completed"}\\n'), 300);`),
      {}, 'p', '/tmp', {}, process.cwd(),
    );
    const after = Date.now();
    assert.ok(durationOf(span) >= 300, `duration ${durationOf(span)}ms covers the 300ms the child slept`);
    // The span cannot claim more time than the whole call took (same clock brackets both ends).
    assert.ok(Date.parse(span.from) >= before && Date.parse(span.to) <= after, 'span sits inside the call window');
  });

  test('a spawn that exits non-zero still reports the duration it burned, on the error', async () => {
    await assert.rejects(
      runEngine(sleeperAdapter(`setTimeout(() => process.exit(3), 300);`), {}, 'p', '/tmp', {}, process.cwd()),
      err => {
        assert.match(err.message, /exited with status 3/);
        assert.ok(err.span, 'the failed spawn carries its span');
        assert.ok(durationOf(err.span) >= 300, `duration ${durationOf(err.span)}ms covers the time before the failure`);
        return true;
      },
    );
  });

  test('a spawn killed at the deadline still reports the duration it burned, on the error', async () => {
    await assert.rejects(
      runEngine(sleeperAdapter('setTimeout(() => {}, 30000);'), {}, 'p', '/tmp', {}, process.cwd(), Date.now() + 400),
      err => {
        assert.ok(err instanceof DeadlineExceededError);
        assert.ok(err.span, 'the killed spawn carries its span');
        // The kill fires at ~400ms; the settle waits for the tree to exit, so the duration can only exceed it.
        assert.ok(durationOf(err.span) >= 350, `duration ${durationOf(err.span)}ms covers the budget it consumed`);
        return true;
      },
    );
  });

  test('a spawn refused before it starts carries no span — nothing ran, so there is nothing to time', async () => {
    await assert.rejects(
      runEngine(sleeperAdapter(''), {}, 'p', '/tmp', {}, process.cwd(), Date.now() - 1),
      err => err instanceof DeadlineExceededError && err.span === undefined,
    );
  });
});

// [LAW:one-type-per-behavior] The session seam: the spec's session decides how the engine is talked to
// and what value its output is. promptOnStdin (every test above) yields the retained stdout; a
// protocol session yields whatever it learned. runEngine settles on that value on a clean exit and
// on the session's rejection when the conversation failed, even though the process exited 0.
describe('runEngine session seam', () => {
  const echoChild = () => ({
    command: process.execPath,
    // Echo stdin lines back with a prefix, then exit when stdin ends — a stand-in for a server.
    args: ['-e', `process.stdin.on('data', d => process.stdout.write('echo:' + d)); process.stdin.on('end', () => process.exit(0));`],
    env: { PATH: process.env.PATH },
  });

  test("a protocol session's output value — not the raw stdout — is what assertSucceeded and the resolution receive", async () => {
    const seen = [];
    const spec = {
      name: 'fake-server',
      timeoutMs: 30_000,
      buildCommand: echoChild,
      session: async (io, prompt) => {
        const reply = new Promise(resolve => io.lines.once('line', resolve));
        io.write(prompt + '\n');
        const line = await reply;
        io.end();
        return { line };
      },
      assertSucceeded: output => { seen.push(output); },
      classifyError: err => err,
    };
    const { output } = await runEngine(spec, {}, 'hello', '/tmp', {}, process.cwd());
    assert.deepEqual(output, { line: 'echo:hello' });
    assert.deepEqual(seen, [{ line: 'echo:hello' }]);
  });

  test('a session that rejects mid-conversation fails the spawn loudly on a clean exit', async () => {
    const spec = {
      name: 'fake-server',
      timeoutMs: 30_000,
      buildCommand: echoChild,
      session: async () => { throw new Error('thread/start failed: no such model'); },
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(runEngine(spec, {}, 'hello', '/tmp', {}, process.cwd()), /thread\/start failed: no such model/);
  });

  test("a session still awaiting the engine settles when the engine exits first — `closed` is every session's floor", async () => {
    const spec = {
      name: 'fake-server',
      timeoutMs: 30_000,
      buildCommand: () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: { PATH: process.env.PATH } }),
      session: async io => {
        const never = new Promise(() => {});
        return Promise.race([never, io.closed.then(() => { throw new Error('engine exited before completing'); })]);
      },
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(runEngine(spec, {}, 'hello', '/tmp', {}, process.cwd()), /exited before completing/);
  });

  test('a session that never settles after the engine exits fails the spawn instead of hanging to the timeout', async () => {
    const spec = {
      name: 'fake-server',
      timeoutMs: 30_000,
      buildCommand: () => ({ command: process.execPath, args: ['-e', 'process.exit(0)'], env: { PATH: process.env.PATH } }),
      session: () => new Promise(() => {}),
      assertSucceeded: () => {},
      classifyError: err => err,
    };
    await assert.rejects(runEngine(spec, {}, 'hello', '/tmp', {}, process.cwd()), /fake-server session did not settle when the engine exited/);
  });
});
