'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, resolveLanes, suitePin, planJobs, renderReport, formatDuration, outcomeLabel } = require('../eval/freeze-suite');

// The contract these tests hold is the SCHEDULE: how many replays are still owed, in what order, on
// which credential, and what the operator is told afterwards. The replay itself belongs to run-case.js
// and is tested there — nothing here spawns an engine. [LAW:behavior-not-structure]

test('parseArgs defaults to the standing baseline depth and the repo layout', () => {
  const o = parseArgs([]);
  assert.equal(o.repeats, 5);
  assert.equal(o.out, 'eval/out');
  assert.equal(o.casesDir, 'eval/cases');
  assert.equal(o.credentials, null);
  assert.equal(o.jobTimeout, 120);
});

test('parseArgs supports -n, --flag=value, and --help', () => {
  const o = parseArgs(['-n', '3', '--out=tmp/freeze', '--cases-dir', 'tmp/cases', '--credentials', 'A,B']);
  assert.equal(o.repeats, 3);
  assert.equal(o.out, 'tmp/freeze');
  assert.equal(o.casesDir, 'tmp/cases');
  assert.equal(o.credentials, 'A,B');
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['eval/cases/foo']), /Unexpected positional argument/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['--out']), /requires a value/);
  // A missing value that swallows the next flag would silently drop the operator's intent.
  assert.throws(() => parseArgs(['--out', '--credentials']), /looks like another flag/);
  assert.throws(() => parseArgs(['-n', '0']), /positive integer/);
  assert.throws(() => parseArgs(['-n', '2.5']), /positive integer/);
  assert.throws(() => parseArgs(['--job-timeout', '0']), /positive integer/);
});

describe('planJobs', () => {
  const cases = [
    { name: 'alpha', dir: 'eval/cases/alpha', completed: 0 },
    { name: 'beta', dir: 'eval/cases/beta', completed: 0 },
  ];

  test('an untouched suite owes repeats × cases replays', () => {
    const jobs = planJobs({ cases, repeats: 3 });
    assert.equal(jobs.length, 6);
    assert.deepEqual(jobs.map(j => j.name), ['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta']);
    assert.deepEqual(jobs.map(j => j.level), [1, 1, 2, 2, 3, 3]);
    assert.equal(jobs[0].dir, 'eval/cases/alpha');
  });

  // The reason the order matters: an interrupted suite must still be freezable. Filling level by level
  // leaves every case at the same depth, which is the one common N baseline.js demands.
  test('the shallowest case is served first, so an interruption leaves an even suite', () => {
    const jobs = planJobs({
      cases: [
        { name: 'alpha', dir: 'a', completed: 4 },
        { name: 'beta', dir: 'b', completed: 1 },
      ],
      repeats: 5,
    });
    assert.deepEqual(jobs.map(j => `${j.name}@${j.level}`), ['beta@2', 'beta@3', 'beta@4', 'alpha@5', 'beta@5']);
  });

  test('a case already at target owes nothing, and neither does a finished suite', () => {
    const jobs = planJobs({
      cases: [
        { name: 'alpha', dir: 'a', completed: 5 },
        { name: 'beta', dir: 'b', completed: 3 },
      ],
      repeats: 5,
    });
    assert.deepEqual(jobs.map(j => j.name), ['beta', 'beta']);
    assert.deepEqual(planJobs({ cases: [{ name: 'alpha', dir: 'a', completed: 5 }], repeats: 5 }), []);
  });

  // Runs beyond the target are not a reason to re-plan — a suite that overshot is already deep enough.
  test('a case past target owes nothing', () => {
    assert.deepEqual(planJobs({ cases: [{ name: 'alpha', dir: 'a', completed: 9 }], repeats: 5 }), []);
  });
});

describe('resolveLanes', () => {
  test('names become lanes carrying their credential values', () => {
    const lanes = resolveLanes(['TOKEN_A', ' TOKEN_B '], { TOKEN_A: 'aaa', TOKEN_B: 'bbb' });
    assert.deepEqual(lanes, [{ name: 'TOKEN_A', value: 'aaa' }, { name: 'TOKEN_B', value: 'bbb' }]);
  });

  test('an unset, empty, or repeated name is refused before any spend', () => {
    assert.throws(() => resolveLanes(['TOKEN_A', 'MISSING'], { TOKEN_A: 'aaa' }), /'MISSING'.*unset or empty/);
    assert.throws(() => resolveLanes(['TOKEN_A'], { TOKEN_A: '   ' }), /unset or empty/);
    assert.throws(() => resolveLanes(['TOKEN_A', ''], { TOKEN_A: 'aaa' }), /empty name/);
    assert.throws(() => resolveLanes(['TOKEN_A', 'TOKEN_A'], { TOKEN_A: 'aaa' }), /more than once/);
  });
});

describe('suitePin', () => {
  const pin = { provider: 'claude-subscription', model: 'claude-sonnet-5', reasoning: null };

  test('a suite on one engine yields that engine', () => {
    assert.deepEqual(suitePin([{ name: 'a', engine: pin }, { name: 'b', engine: { ...pin } }]), pin);
  });

  test('a mixed suite is refused, naming both pins', () => {
    assert.throws(
      () => suitePin([{ name: 'a', engine: pin }, { name: 'b', engine: { ...pin, model: 'deepseek-v4-pro' } }]),
      /Case 'b' pins .*deepseek-v4-pro.* but 'a' pins .*claude-sonnet-5.*one engine/s,
    );
    assert.throws(
      () => suitePin([{ name: 'a', engine: pin }, { name: 'b', engine: { ...pin, reasoning: 'high' } }]),
      /one engine/,
    );
  });

  test('an empty golden set is refused rather than freezing nothing', () => {
    assert.throws(() => suitePin([]), /No golden cases/);
  });
});

describe('renderReport', () => {
  const jobs = [
    { name: 'alpha', level: 1, lane: 'TOKEN_A', ok: true, outcome: 'ok', durationMs: 65000, log: 'out/logs/alpha.log' },
    { name: 'beta', level: 1, lane: 'TOKEN_B', ok: false, outcome: 'FAILED (exit 1)', durationMs: 4000, log: 'out/logs/beta.log' },
  ];

  test('every attempt is listed, and a failure carries its exit code and log', () => {
    const md = renderReport({ jobs, census: [{ name: 'alpha', completed: 1 }, { name: 'beta', completed: 0 }], repeats: 2, elapsedMs: 69000 });
    assert.match(md, /\| 1 \| alpha \| TOKEN_A \| ok \| 1m05s \| out\/logs\/alpha\.log \|/);
    assert.match(md, /\| 1 \| beta \| TOKEN_B \| FAILED \(exit 1\) \| 4s \| out\/logs\/beta\.log \|/);
  });

  // The number the operator actually needs when a suite comes up short: the deepest N that is freezable
  // today, which is the SHALLOWEST case — not the total replay count, which says nothing about evenness.
  test('a short suite reports the deepest freezable N', () => {
    const md = renderReport({ jobs, census: [{ name: 'alpha', completed: 5 }, { name: 'beta', completed: 3 }], repeats: 5, elapsedMs: 1000 });
    assert.match(md, /SUITE SHORT of N=5.*at least 3 run\(s\).*deepest freezable suite today is N=3/s);
  });

  test('a met target reports complete, and points at the next step', () => {
    const md = renderReport({ jobs, census: [{ name: 'alpha', completed: 5 }, { name: 'beta', completed: 5 }], repeats: 5, elapsedMs: 1000 });
    assert.match(md, /SUITE COMPLETE at N=5/);
    assert.match(md, /eval\/baseline\.js/);
  });
});

// A deadline that expired and an engine that refused are different diagnoses with different fixes; the
// label the operator reads must not merge them. [LAW:no-silent-failure]
describe('outcomeLabel', () => {
  test('a clean exit is the only ok', () => {
    assert.equal(outcomeLabel({ exitCode: 0, signal: null, timedOut: false, timeoutMinutes: 60 }), 'ok');
    assert.equal(outcomeLabel({ exitCode: 1, signal: null, timedOut: false, timeoutMinutes: 60 }), 'FAILED (exit 1)');
  });

  test('a deadline kill says so, and does not masquerade as a refused replay', () => {
    const label = outcomeLabel({ exitCode: null, signal: 'SIGTERM', timedOut: true, timeoutMinutes: 60 });
    assert.equal(label, 'TIMED OUT (killed after 60m)');
  });

  test('a kill from outside is named by its signal', () => {
    assert.equal(outcomeLabel({ exitCode: null, signal: 'SIGINT', timedOut: false, timeoutMinutes: 60 }), 'KILLED (SIGINT)');
  });
});

test('formatDuration reads as wall clock at both scales', () => {
  assert.equal(formatDuration(4200), '4s');
  assert.equal(formatDuration(65000), '1m05s');
  assert.equal(formatDuration(3600000), '60m00s');
});
