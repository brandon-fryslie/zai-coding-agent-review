'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseBaseline, BASELINE_SCHEMA } = require('../eval/baseline');
const { PROVIDERS, PROVIDER_ALIASES } = require('../src/provider');

// These tests read the COMMITTED baselines under eval/baseline/ — the artifacts the quality gate
// measures candidates against — as opposed to test/eval-baseline.test.js, which holds the reducer's
// contract with in-memory fixtures. Both are needed: a perfect reducer over a baseline the gate can no
// longer use is a gate that does not gate. [LAW:behavior-not-structure]
//
// Deliberately NO git: compare.js ranks baselines by commit graph, but `npm test` runs on a shallow
// checkout where that ranking is an unresolvable tie by design. The facts asserted here — every frozen
// artifact loads, and one of them characterizes the engine the action actually resolves to — hold
// without history.

const BASELINE_ROOT = path.join(__dirname, '..', 'eval', 'baseline');

// The gate-eligible baselines: those stamped with the CURRENT schema. Superseded freezes stay committed
// as history (eval/baseline/2026-08-01-dc87ee0 is schema v1), and parseBaseline rightly refuses them — so
// they are excluded by their own recorded schema, never by catching the refusal. [LAW:no-silent-failure]
function committedBaselines() {
  const raw = fs.readdirSync(BASELINE_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(BASELINE_ROOT, e.name, 'baseline.json')))
    .map(e => ({ name: e.name, text: fs.readFileSync(path.join(BASELINE_ROOT, e.name, 'baseline.json'), 'utf8') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.ok(raw.length > 0, `No committed baseline under ${BASELINE_ROOT} — the quality gate has no reference.`);
  const current = raw.filter(r => JSON.parse(r.text).schema === BASELINE_SCHEMA);
  assert.ok(current.length > 0, `No committed baseline carries the current schema ${BASELINE_SCHEMA} — every freeze is superseded history.`);
  return current.map(({ name, text }) => ({ name, baseline: parseBaseline(text, name) }));
}

// A committed baseline that no longer parses is a gate that cannot run — and the gate is the one thing
// standing between a recall regression and main. parseBaseline is the loader compare.js itself uses, so
// this asserts loadability against the real reader rather than a re-implementation of it.
test('every current-schema baseline loads through the gate’s own loader', () => {
  for (const { name, baseline } of committedBaselines()) {
    assert.ok(baseline.repeats >= 1, `${name}: repeats must be a positive N`);
    assert.ok(baseline.cases.length > 0, `${name}: a baseline with no cases characterizes nothing`);
    assert.ok(baseline.engine && baseline.engine.provider, `${name}: no engine pin`);
  }
});

// THE regression this file exists for. The harness sat unrunnable for weeks because 1.42.0 retargeted
// PROVIDER=auto to claude-subscription while every frozen artifact still described deepseek: the gate's
// reference described an engine the action no longer runs, and nothing said so — the only symptom was a
// confusing "credential not set" at replay time. This test is that silence made loud. If the default
// provider or its default model moves again, it reds the moment the move lands, naming the re-freeze as
// the fix. [LAW:no-silent-failure] [FRAMING:representation]
test('a committed baseline characterizes the engine PROVIDER=auto resolves to', () => {
  const liveProvider = PROVIDER_ALIASES.auto;
  const liveModel = PROVIDERS[liveProvider].defaultModel;
  const baselines = committedBaselines();
  const onLiveEngine = baselines.filter(b => b.baseline.engine.provider === liveProvider && b.baseline.engine.model === liveModel);
  assert.ok(
    onLiveEngine.length > 0,
    `No committed baseline is frozen on ${liveProvider}/${liveModel} — the engine PROVIDER=auto resolves to. ` +
    `Committed: ${baselines.map(b => `${b.name} (${b.baseline.engine.provider}/${b.baseline.engine.model})`).join(', ')}. ` +
    `Re-freeze the suite on the live engine (eval/freeze-suite.js → eval/score.js → eval/baseline.js).`,
  );
});

// The golden set is the suite; a baseline that skipped a case measured a different population than the
// gate will. baseline.js refuses to freeze that, and this holds the refusal true for what is committed.
test('the live-engine baseline covers every golden case', () => {
  const liveProvider = PROVIDER_ALIASES.auto;
  const liveModel = PROVIDERS[liveProvider].defaultModel;
  const casesDir = path.join(__dirname, '..', 'eval', 'cases');
  const golden = fs.readdirSync(casesDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(casesDir, e.name, 'case.json')))
    .map(e => e.name)
    .sort();
  const onLiveEngine = committedBaselines()
    .filter(b => b.baseline.engine.provider === liveProvider && b.baseline.engine.model === liveModel);
  for (const { name, baseline } of onLiveEngine) {
    assert.deepEqual(baseline.cases.map(c => c.case).sort(), golden, `${name}: baseline cases must be the golden set`);
  }
});
