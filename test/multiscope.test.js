'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  workerFocusText,
  sumUsage,
  composeSummary,
  planScopes,
  runScopeWorkers,
  runMultiScopePass,
  runMultiScope,
  buildPrMaterial,
  buildRepoMaterial,
} = require('../src/multiscope');
const { defaultEffortProfile } = require('../src/effort');
const { buildReviewInput, buildPrScoutInput, buildRepoScoutInput } = require('../src/prompt');
const { parseScopeValue, dedupeFindings } = require('../src/review');
const { TransientError } = require('../src/failover');

const TOOL_NAMES = {
  requestChange: 'mcp__review_collector__request_change',
  finishReview: 'mcp__review_collector__finish_review',
  addScope: 'mcp__review_collector__add_scope',
  assessDependency: 'mcp__review_collector__assess_dependency',
};
const REPO_ROOT = '/home/runner/work/acme/acme';

// ── parseScopeValue — typed scope records from the add_scope tool (mirrors parseFindingValue) ─────
// The plan is no longer parsed from prose; the scout records each scope through the collector, so the
// validation lives at the same boundary as a finding's, never in a bracket scanner.

describe('parseScopeValue', () => {
  test('accepts a {name, focus} record, trims both fields, defaults files to []', () => {
    assert.deepEqual(parseScopeValue({ name: ' cost ', focus: ' src/usage.js ' }, 0), { name: 'cost', focus: 'src/usage.js', files: [] });
  });
  test('parses and trims the files array when present', () => {
    assert.deepEqual(
      parseScopeValue({ name: 'cost', focus: 'x', files: [' src/usage.js ', 'src/report.js'] }, 0),
      { name: 'cost', focus: 'x', files: ['src/usage.js', 'src/report.js'] },
    );
  });
  test('drops non-string / blank file entries rather than injecting an empty path', () => {
    assert.deepEqual(
      parseScopeValue({ name: 'a', focus: 'x', files: ['a.js', '', '  ', 42, null] }, 0).files,
      ['a.js'],
    );
  });
  test('a non-array files field is treated as no assignment ([])', () => {
    assert.deepEqual(parseScopeValue({ name: 'a', focus: 'x', files: 'a.js' }, 0).files, []);
  });
  test('rejects a missing/empty name', () => {
    assert.throws(() => parseScopeValue({ focus: 'x' }, 0), /invalid name/);
    assert.throws(() => parseScopeValue({ name: '  ', focus: 'x' }, 0), /invalid name/);
  });
  test('rejects a missing/empty focus', () => {
    assert.throws(() => parseScopeValue({ name: 'a' }, 0), /invalid focus/);
  });
  test('rejects a non-object', () => {
    assert.throws(() => parseScopeValue('nope', 0), /is not an object/);
  });
});

describe('workerFocusText', () => {
  test('prepends structural context when present', () => {
    const text = workerFocusText({ name: 'cost', focus: 'src/usage.js' }, 'A CLI tool.');
    assert.match(text, /Structural context from the planning pass:\nA CLI tool\./);
    assert.match(text, /cost — src\/usage\.js/);
  });
  test('omits the context block when context is empty', () => {
    const text = workerFocusText({ name: 'cost', focus: 'src/usage.js' }, '');
    assert.doesNotMatch(text, /Structural context/);
    assert.equal(text, 'cost — src/usage.js');
  });
});

// ── dedupeFindings ────────────────────────────────────────────────────────────────────────────

describe('dedupeFindings', () => {
  test('drops exact-duplicate findings by path:line:body, preserving order', () => {
    const findings = [
      { path: 'a.js', line: 1, body: '[LAW:x] foo', severity: 'blocking' },
      { path: 'b.js', line: 2, body: '[LAW:y] bar', severity: 'blocking' },
      { path: 'a.js', line: 1, body: '[LAW:x] foo', severity: 'blocking' },
    ];
    const out = dedupeFindings(findings);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(f => f.path), ['a.js', 'b.js']);
  });

  test('keeps two findings on the same line with different bodies', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'first distinct issue here', severity: 'blocking' },
      { path: 'a.js', line: 1, body: 'second different issue here', severity: 'advisory' },
    ]);
    assert.equal(out.length, 2);
  });

  // [FRAMING:representation] The old key sliced the body to 60 chars; the prompt mandates every body open
  // with a category tag, so two DISTINCT findings on one line share a long prefix and diverge only later.
  // Keying on the full body keeps them apart — a recorded finding is never silently merged away.
  test('keeps two same-line findings that share a >60-char prefix but differ later', () => {
    const shared = 'Bug: this comparison on the id field looks wrong and needs a closer look here '; // 77 chars
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: `${shared}because it uses = instead of ===`, severity: 'blocking' },
      { path: 'a.js', line: 1, body: `${shared}because it runs before the guard`, severity: 'advisory' },
    ]);
    assert.equal(out.length, 2);
  });

  // Byte-identical bodies modulo whitespace/case are the real double-record case: they still collapse.
  test('dedupes bodies that differ only in whitespace and case', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'Bug:  the   guard is missing', severity: 'blocking' },
      { path: 'a.js', line: 1, body: 'bug: the guard is missing', severity: 'blocking' },
    ]);
    assert.equal(out.length, 1);
  });

  // [LAW:no-silent-failure] severity decides the merge gate, so a duplicate must not lose it to order.
  test('a blocking duplicate wins over an advisory that arrived first (upward merge)', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'same issue', severity: 'advisory' },
      { path: 'a.js', line: 1, body: 'same issue', severity: 'blocking' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, 'blocking'); // advisory-first never downgrades the merged finding
  });

  test('a blocking finding is not downgraded by a later advisory duplicate', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'same issue', severity: 'blocking' },
      { path: 'a.js', line: 1, body: 'same issue', severity: 'advisory' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, 'blocking');
  });

  test('merging preserves first-seen order across keys', () => {
    const out = dedupeFindings([
      { path: 'a.js', line: 1, body: 'x', severity: 'advisory' },
      { path: 'b.js', line: 2, body: 'y', severity: 'blocking' },
      { path: 'a.js', line: 1, body: 'x', severity: 'blocking' }, // upgrades a.js in place
    ]);
    assert.deepEqual(out.map(f => f.path), ['a.js', 'b.js']); // a.js keeps its original position
    assert.equal(out[0].severity, 'blocking');
  });
});

// ── sumUsage — cost is uniform because every spawn shares one config ──────────────────────────────

describe('sumUsage', () => {
  test('sums tokens and available cost across spawns', () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 5, cost: { available: true, usd: 0.1 } },
      { inputTokens: 20, outputTokens: 7, cost: { available: true, usd: 0.2 } },
    ]);
    assert.equal(total.inputTokens, 30);
    assert.equal(total.outputTokens, 12);
    assert.equal(total.cost.available, true);
    assert.ok(Math.abs(total.cost.usd - 0.3) < 1e-9);
  });

  test('any unavailable cost makes the total unavailable, carrying its reason', () => {
    const total = sumUsage([
      { inputTokens: 10, outputTokens: 5, cost: { available: true, usd: 0.1 } },
      { inputTokens: 20, outputTokens: 7, cost: { available: false, reason: 'no-price' } },
    ]);
    assert.equal(total.cost.available, false);
    assert.equal(total.cost.reason, 'no-price');
    assert.equal(total.inputTokens, 30); // tokens still sum
  });

  test('excludes null usages but still sums the present ones', () => {
    const total = sumUsage([null, { inputTokens: 4, outputTokens: 2, cost: { available: true, usd: 0.05 } }]);
    assert.equal(total.inputTokens, 4);
    assert.equal(total.cost.usd, 0.05);
  });

  test('returns null when no spawn reported usage', () => {
    assert.equal(sumUsage([null, null]), null);
    assert.equal(sumUsage([]), null);
  });
});

// ── composeSummary ────────────────────────────────────────────────────────────────────────────

describe('composeSummary', () => {
  const scopes = [{ name: 'cost', focus: 'x' }, { name: 'diff', focus: 'y' }];
  test('names every scope and carries each worker summary, never raw JSON', () => {
    const summary = composeSummary(scopes, [
      { name: 'cost', summary: 'Looks fine.' },
      { name: 'diff', summary: 'One issue.' },
    ]);
    assert.match(summary, /Reviewed 2 scope\(s\): cost, diff\./);
    assert.match(summary, /\*\*cost\*\* — Looks fine\./);
    assert.match(summary, /\*\*diff\*\* — One issue\./);
    assert.doesNotMatch(summary, /[[{]"name"/);
  });
  test('renders a placeholder for an empty worker summary', () => {
    const summary = composeSummary([{ name: 'a', focus: 'x' }], [{ name: 'a', summary: '' }]);
    assert.match(summary, /\*\*a\*\* — \(no summary\)/);
  });
});

// ── runScopeWorkers — fail-loud bounded pool ─────────────────────────────────────────────────────

describe('runScopeWorkers', () => {
  test('returns results in scope order regardless of completion order', async () => {
    const scopes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const runOne = async (s) => {
      await new Promise(r => setTimeout(r, s.name === 'a' ? 5 : 0)); // a finishes last
      return { name: s.name };
    };
    const results = await runScopeWorkers({ scopes, runOne, maxConcurrent: 3 });
    assert.deepEqual(results.map(r => r.name), ['a', 'b', 'c']);
  });

  test('rethrows the first error, preserving its type, so failover can classify it', async () => {
    const scopes = [{ name: 'a' }, { name: 'b' }];
    const runOne = async (s) => { if (s.name === 'b') throw new TransientError('rate-limited'); return { name: s.name }; };
    await assert.rejects(
      runScopeWorkers({ scopes, runOne, maxConcurrent: 1 }),
      (err) => err instanceof TransientError && /rate-limited/.test(err.message),
    );
  });

  test('a non-transient worker error propagates (never swallowed into an empty result)', async () => {
    const scopes = [{ name: 'a' }];
    const runOne = async () => { throw new Error('engine produced garbage'); };
    await assert.rejects(runScopeWorkers({ scopes, runOne, maxConcurrent: 2 }), /engine produced garbage/);
  });
});

// ── spawn-level transient resilience (the g6x fix) ─────────────────────────────────────────────────
// A transient blip in ONE scope worker must be retried IN PLACE, so it never discards the sibling
// workers' already-recorded findings by failing (and re-running) the whole scout->workers pass.

describe('runMultiScopePass — spawn-level transient resilience', () => {
  const SCOPES = [
    { name: 'a', focus: 'fa' },
    { name: 'b', focus: 'fb' },
    { name: 'c', focus: 'fc' },
  ];
  const material = {
    changedPaths: [], // no coverage sweep in this suite; scope-worker resilience is what's under test
    buildScoutPrompt: () => 'SCOUT',
    buildWorkerPrompt: (focusText) => focusText, // focusText carries `${scope.name} — ${scope.focus}`
  };
  const config = { engine: 'fake', name: 'c1' };
  const passArgs = (registry) => ({
    config, material, registry, instructionsPath: 'x', maxConcurrent: 4, log: () => {}, sleepFn: async () => {},
  });

  // A fake engine adapter: the scout returns SCOPES; each worker returns one finding tagged with its
  // scope. `flaky` names a scope whose worker throws a transient error ONCE before succeeding.
  function makeRegistry({ flaky } = {}) {
    const calls = { scout: 0, workers: {} };
    const adapter = {
      async produceReview({ buildPromptFor }) {
        const prompt = buildPromptFor({});
        if (prompt === 'SCOUT') {
          calls.scout++;
          return { summary: 'ctx', findings: [], scopes: SCOPES, usage: null };
        }
        const scope = SCOPES.find(s => prompt.includes(`${s.name} — ${s.focus}`));
        calls.workers[scope.name] = (calls.workers[scope.name] ?? 0) + 1;
        if (flaky === scope.name && calls.workers[scope.name] === 1) {
          throw new TransientError('API Error: terminated');
        }
        return {
          summary: `sum-${scope.name}`,
          findings: [{ path: `${scope.name}.js`, line: 1, body: `bug in ${scope.name}` }],
          usage: null,
        };
      },
    };
    return { registry: { get: () => adapter }, calls };
  }

  test("a transient blip in one of N workers does not discard the other N-1 workers' findings", async () => {
    const { registry, calls } = makeRegistry({ flaky: 'b' });
    const review = await runMultiScopePass(passArgs(registry));
    // All three scopes' findings survive — the blip on 'b' was retried in place.
    assert.deepEqual(review.findings.map(f => f.path).sort(), ['a.js', 'b.js', 'c.js']);
    // The scout ran exactly ONCE (the whole pass was not re-run), and only 'b' was re-spawned.
    assert.equal(calls.scout, 1);
    assert.equal(calls.workers.a, 1);
    assert.equal(calls.workers.b, 2); // 1 blip + 1 successful retry
    assert.equal(calls.workers.c, 1);
  });

  test("a worker's dependency assessments reach the aggregated review (they are not dropped at the worker seam)", async () => {
    // Regression: runScopeWorker once destructured only {summary,findings,usage}, silently dropping the
    // assessments the adapter returned — every bump then rendered "unassessed". This asserts the CONTRACT
    // (a worker's assessments survive aggregation), independent of how runScopeWorker forwards them.
    const adapter = {
      async produceReview({ buildPromptFor }) {
        const prompt = buildPromptFor({});
        if (prompt === 'SCOUT') return { summary: 'ctx', findings: [], scopes: SCOPES, assessments: [], usage: null };
        const scope = SCOPES.find(s => prompt.includes(`${s.name} — ${s.focus}`));
        // Only scope 'b' owns the go.mod bump and records an assessment; the others record none.
        const assessments = scope.name === 'b'
          ? [{ module: 'github.com/a/b', impact: 'adds retries', affected: false, callSite: null, verdict: 'safe' }]
          : [];
        return { summary: `sum-${scope.name}`, findings: [], assessments, usage: null };
      },
    };
    const review = await runMultiScopePass(passArgs({ get: () => adapter }));
    assert.equal(review.assessments.length, 1, 'the single worker assessment must survive to the aggregate');
    assert.deepEqual(review.assessments[0], { module: 'github.com/a/b', impact: 'adds retries', affected: false, callSite: null, verdict: 'safe' });
  });

  test('a transient error that persists past spawn retries propagates loudly — no scope is silently dropped', async () => {
    const alwaysFlaky = {
      async produceReview({ buildPromptFor }) {
        if (buildPromptFor({}) === 'SCOUT') return { summary: 'ctx', findings: [], scopes: SCOPES, usage: null };
        throw new TransientError('API Error: terminated');
      },
    };
    // The blip never clears, so it escalates (still transient) to produceReview's config-level failover
    // instead of being swallowed into a partial review. runScopeWorkers stays fail-loud.
    await assert.rejects(
      runMultiScopePass(passArgs({ get: () => alwaysFlaky })),
      err => err instanceof TransientError,
    );
  });
});

// ── runMultiScope — the reasoning FOLD: the effort profile's proposed tier meets the chain here ────
// The migration consumer for reasoningTier (zai-difficulty-0ea.3): runMultiScope folds the profile's
// proposed raise onto each config's own reasoning as a maxTier FLOOR before the pass runs, so every
// engine spawn — and configUsed (hence the attribution footer) — carries the effective tier.
describe('runMultiScope — reasoningTier fold onto the chain', () => {
  const material = {
    changedPaths: [],
    buildScoutPrompt: () => 'SCOUT',
    buildWorkerPrompt: (focusText) => focusText,
  };
  const SCOPES = [{ name: 'a', focus: 'fa' }];

  // A fake adapter that records the `reasoning` of every config it is spawned with.
  function recordingRegistry(seen) {
    const adapter = {
      async produceReview({ config, buildPromptFor }) {
        seen.push(config.reasoning);
        if (buildPromptFor({}) === 'SCOUT') return { summary: 'ctx', findings: [], scopes: SCOPES, usage: null };
        return { summary: 'sum', findings: [], usage: null };
      },
    };
    return { get: () => adapter };
  }

  const runWith = async ({ chain, reasoningTier }) => {
    const seen = [];
    const { configUsed } = await runMultiScope({
      chain, material, registry: recordingRegistry(seen), instructionsPath: 'x',
      effort: defaultEffortProfile({ roundCap: 5, reasoningTier }), log: () => {}, sleepFn: async () => {},
    });
    return { seen, configUsed };
  };

  test('a proposed raise LIFTS an under-specified config — the engine spawns at the raised tier', async () => {
    const { seen, configUsed } = await runWith({ chain: [{ engine: 'fake', name: 'c1', reasoning: 'low' }], reasoningTier: 'high' });
    for (const r of seen) assert.equal(r, 'high'); // scout + every worker spawn saw the floor
    assert.equal(configUsed.reasoning, 'high');     // configUsed (→ footer) reports the raise
  });

  test('a null proposed tier leaves each config\'s own reasoning untouched (byte-identical)', async () => {
    const { seen, configUsed } = await runWith({ chain: [{ engine: 'fake', name: 'c1', reasoning: 'low' }], reasoningTier: null });
    for (const r of seen) assert.equal(r, 'low');
    assert.equal(configUsed.reasoning, 'low');
  });

  test('an explicit higher config is NEVER lowered by a smaller proposed raise', async () => {
    const { seen, configUsed } = await runWith({ chain: [{ engine: 'fake', name: 'c1', reasoning: 'max' }], reasoningTier: 'high' });
    for (const r of seen) assert.equal(r, 'max');
    assert.equal(configUsed.reasoning, 'max');
  });

  test('a config with no reasoning at all takes the raise as its floor (null baseline → raise)', async () => {
    const { seen, configUsed } = await runWith({ chain: [{ engine: 'fake', name: 'c1' }], reasoningTier: 'high' });
    for (const r of seen) assert.equal(r, 'high');
    assert.equal(configUsed.reasoning, 'high');
  });

  test('the fold applies to the FAILOVER config too — a second config reached after the first fails carries the raise', async () => {
    // The fold is chain.map, so every config gets it; this proves the config produceReview advances TO
    // (after the first throws a persistent transient) also spawns at the folded tier, and configUsed is it.
    const seen = [];
    const adapters = {
      c1: { async produceReview() { throw new TransientError('API Error: terminated'); } },
      c2: {
        async produceReview({ config, buildPromptFor }) {
          seen.push(config.reasoning);
          if (buildPromptFor({}) === 'SCOUT') return { summary: 'ctx', findings: [], scopes: SCOPES, usage: null };
          return { summary: 'sum', findings: [], usage: null };
        },
      },
    };
    const registry = { get: (name) => name === 'e1' ? adapters.c1 : adapters.c2 };
    const { configUsed } = await runMultiScope({
      chain: [
        { engine: 'e1', name: 'c1', reasoning: 'low' },
        { engine: 'e2', name: 'c2', reasoning: 'low' },
      ],
      material, registry, instructionsPath: 'x',
      effort: defaultEffortProfile({ roundCap: 5, reasoningTier: 'high' }), log: () => {}, sleepFn: async () => {},
    });
    assert.ok(seen.length > 0, 'the failover config must have been spawned');
    for (const r of seen) assert.equal(r, 'high'); // the second (failover) config also got the fold
    assert.equal(configUsed.name, 'c2');
    assert.equal(configUsed.reasoning, 'high');
  });
});

// ── planScopes — mechanical scout-coverage verification (598.3, now file-set based) ───────────────
// The scout assigns every changed file to a scope via scope.files; planScopes verifies that assignment
// by EXACT set membership. A changed path no scope claimed is swept into ONE synthetic 'unassigned
// files' scope (carrying those paths in its own files) so some worker reads it in full — DEEP coverage
// guaranteed as a value, not left to the plan or recovered from prose.

describe('planScopes', () => {
  const scopes = [
    { name: 'cost', focus: 'pricing math', files: ['src/usage.js'] },
    { name: 'transport', focus: 'GitHub review submission', files: ['src/transport.js'] },
  ];

  test('a changed path claimed by no scope is swept into one synthetic scope + reported', () => {
    const { scopes: planned, sweptPaths } = planScopes(scopes, ['src/usage.js', 'src/report.js']);
    assert.deepEqual(sweptPaths, ['src/report.js']);
    assert.equal(planned.length, 3);
    const synthetic = planned[planned.length - 1];
    assert.equal(synthetic.name, 'unassigned files');
    assert.match(synthetic.focus, /src\/report\.js/);
    assert.match(synthetic.focus, /Review their changes fully/);
    assert.deepEqual(synthetic.files, ['src/report.js']); // the catch-all carries its own files to read
  });

  test('coverage is exact set membership — a path is covered iff it appears in some scope.files', () => {
    const { sweptPaths } = planScopes(
      [{ name: 'cost', focus: 'the usage table', files: ['src/usage.js'] }],
      ['src/usage.js'],
    );
    assert.deepEqual(sweptPaths, []);
  });

  test('full coverage yields no synthetic scope and returns the plan array unchanged', () => {
    const { scopes: planned, sweptPaths } = planScopes(scopes, ['src/usage.js', 'src/transport.js']);
    assert.deepEqual(sweptPaths, []);
    assert.equal(planned, scopes); // same reference — no rebuild when nothing is swept
  });

  test('an empty changedPaths list (repo material) never yields a synthetic scope', () => {
    const { scopes: planned, sweptPaths } = planScopes(scopes, []);
    assert.deepEqual(sweptPaths, []);
    assert.equal(planned, scopes);
  });

  // A path mentioned in a scope's prose but NOT listed in its files is uncovered — the assignment is the
  // files field, not the focus text. This is the exactness the file-set model buys over text-matching:
  // no substring collisions, and no "mentioned in passing" false positives either.
  test('a path named only in focus prose but absent from scope.files is swept', () => {
    const { sweptPaths } = planScopes(
      [{ name: 'engine', focus: 'Review src/multiscope.js and its neighbor src/scope.js', files: ['src/multiscope.js'] }],
      ['src/scope.js'],
    );
    assert.deepEqual(sweptPaths, ['src/scope.js']);
  });

  test('all unassigned paths land in ONE synthetic scope, never one scope each', () => {
    const { scopes: planned, sweptPaths } = planScopes(scopes, ['a.js', 'b.js', 'c.js']);
    assert.deepEqual(sweptPaths, ['a.js', 'b.js', 'c.js']);
    assert.equal(planned.length, 3); // 2 planned + exactly 1 catch-all
    assert.match(planned[2].focus, /a\.js, b\.js, c\.js/);
    assert.deepEqual(planned[2].files, ['a.js', 'b.js', 'c.js']);
  });

  test('a file claimed by two scopes (over-assignment) is reported as a duplicate', () => {
    const overlap = [
      { name: 'a', focus: 'x', files: ['src/shared.js', 'src/a.js'] },
      { name: 'b', focus: 'y', files: ['src/shared.js', 'src/b.js'] },
    ];
    const { duplicatePaths, sweptPaths } = planScopes(overlap, ['src/shared.js', 'src/a.js', 'src/b.js']);
    assert.deepEqual(duplicatePaths, ['src/shared.js']); // read by both workers — the redundant cost
    assert.deepEqual(sweptPaths, []); // every changed file is covered (by at least one scope)
  });

  test('no over-assignment yields an empty duplicatePaths', () => {
    const { duplicatePaths } = planScopes(scopes, ['src/usage.js', 'src/transport.js']);
    assert.deepEqual(duplicatePaths, []);
  });

  test('a file claimed by THREE scopes appears exactly once in duplicatePaths', () => {
    const triple = [
      { name: 'a', focus: 'x', files: ['src/shared.js'] },
      { name: 'b', focus: 'y', files: ['src/shared.js'] },
      { name: 'c', focus: 'z', files: ['src/shared.js'] },
    ];
    const { duplicatePaths } = planScopes(triple, ['src/shared.js']);
    assert.deepEqual(duplicatePaths, ['src/shared.js']); // once, not twice — the includes() guard holds
  });
});

// ── the sweep actually reaches the worker pool (end-to-end through runMultiScopePass) ─────────────

describe('runMultiScopePass — scout coverage sweep', () => {
  const config = { engine: 'fake', name: 'c1' };
  // Scout returns the given plan; each worker echoes its own prompt so we can see which scopes ran.
  function registryFor(scoutScopes) {
    const seen = [];
    const adapter = {
      async produceReview({ buildPromptFor }) {
        const prompt = buildPromptFor({});
        if (prompt === 'SCOUT') return { summary: 'ctx', findings: [], scopes: scoutScopes, usage: null };
        seen.push(prompt);
        return { summary: 'ok', findings: [], usage: null };
      },
    };
    return { registry: { get: () => adapter }, seen };
  }
  const runWith = ({ registry, scoutScopes, changedPaths, log }) =>
    runMultiScopePass({
      config,
      material: { changedPaths, buildScoutPrompt: () => 'SCOUT', buildWorkerPrompt: (f) => f },
      registry, instructionsPath: 'x', maxConcurrent: 4, log, sleepFn: async () => {},
    });

  test('an unassigned changed file gets its own worker (the synthetic scope) and a warning', async () => {
    const { registry, seen } = registryFor([{ name: 'a', focus: 'a.js', files: ['a.js'] }]);
    const logs = [];
    await runWith({ registry, changedPaths: ['a.js', 'b.js'], log: (m) => logs.push(m) });
    assert.ok(seen.some(p => p.includes('unassigned files') && p.includes('b.js')), 'synthetic worker ran for b.js');
    assert.ok(logs.some(m => /unassigned/.test(m) && m.includes('b.js')), 'warning names the swept path');
  });

  test('full coverage runs no synthetic worker and logs no sweep warning', async () => {
    const { registry, seen } = registryFor([{ name: 'a', focus: 'a.js', files: ['a.js'] }, { name: 'b', focus: 'b.js', files: ['b.js'] }]);
    const logs = [];
    await runWith({ registry, changedPaths: ['a.js', 'b.js'], log: (m) => logs.push(m) });
    assert.ok(!seen.some(p => p.includes('unassigned files')));
    assert.ok(!logs.some(m => /unassigned/.test(m)));
  });

  test('repo material (changedPaths: []) never sweeps even when the scout plans one scope', async () => {
    const { registry, seen } = registryFor([{ name: 'whole', focus: 'everything', files: [] }]);
    const logs = [];
    await runWith({ registry, changedPaths: [], log: (m) => logs.push(m) });
    assert.ok(!seen.some(p => p.includes('unassigned files')));
    assert.ok(!logs.some(m => /unassigned/.test(m)));
  });

  test('a file over-assigned to two scopes logs the duplicate warning at the pass level', async () => {
    const { registry } = registryFor([
      { name: 'a', focus: 'a', files: ['shared.js', 'a.js'] },
      { name: 'b', focus: 'b', files: ['shared.js', 'b.js'] },
    ]);
    const logs = [];
    await runWith({ registry, changedPaths: ['shared.js', 'a.js', 'b.js'], log: (m) => logs.push(m) });
    assert.ok(logs.some(m => /more than one scope/.test(m) && m.includes('shared.js')), 'warns naming the doubly-claimed file');
  });
});

// ── materials — closures that build the real engine prompts ──────────────────────────────────────

describe('buildPrMaterial', () => {
  const files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];
  const material = buildPrMaterial({ files, maxDiffChars: 0, reviewedRepoRoot: REPO_ROOT });

  test('exposes the changed-file list so the pass can verify scout coverage against it', () => {
    assert.deepEqual(material.changedPaths, ['src/a.js']);
  });

  test('scout prompt lists the changed file paths and records scopes via the add_scope tool', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /src\/a\.js/);
    assert.match(prompt, /mcp__review_collector__add_scope ONCE PER SCOPE/);
    assert.match(prompt, /mcp__review_collector__finish_review/);
    assert.doesNotMatch(prompt, /JSON array/);
  });

  test('worker prompt is the diff review with a CONCENTRATE focus block', () => {
    const prompt = material.buildWorkerPrompt('cost — src/usage.js', TOOL_NAMES);
    assert.match(prompt, /CONCENTRATE THIS REVIEW on one part of the change: cost — src\/usage\.js/);
    assert.match(prompt, /```diff/);
  });

  test('with assigned scopeFiles, the worker is told to read ONLY those in full (not the whole set)', () => {
    const prompt = material.buildWorkerPrompt('cost', TOOL_NAMES, ['src/usage.js', 'src/report.js']);
    assert.match(prompt, /Read the complete content of THESE files/);
    assert.match(prompt, /src\/usage\.js, src\/report\.js/);
    assert.match(prompt, /Another scope's worker reads the other changed files/);
    // roaming is bounded: prefer Grep for imports, don't pre-read the tree
    assert.match(prompt, /prefer Grep/);
    assert.match(prompt, /Do not pre-read the tree/);
    // the whole diff is still shown (report-anywhere + anchor validity preserved)
    assert.match(prompt, /```diff/);
  });

  test('with no assigned files (single-scope PR), the worker reads every changed file in full', () => {
    const prompt = material.buildWorkerPrompt('cost', TOOL_NAMES, []);
    assert.match(prompt, /Read the complete content of every changed file/);
    assert.doesNotMatch(prompt, /Read the complete content of THESE files/);
  });
});

describe('buildRepoMaterial', () => {
  const material = buildRepoMaterial({ scope: '', excludePatterns: [], reviewedRepoRoot: REPO_ROOT });

  test('exposes an empty changed-file list, making the coverage sweep a no-op by construction', () => {
    assert.deepEqual(material.changedPaths, []);
  });

  test('scout prompt surveys the tree and records scopes via the add_scope tool', () => {
    const prompt = material.buildScoutPrompt(TOOL_NAMES);
    assert.match(prompt, /There is no diff/);
    assert.match(prompt, /mcp__review_collector__add_scope ONCE PER SCOPE/);
    assert.doesNotMatch(prompt, /JSON array/);
  });

  test('worker prompt is a focused whole-repo review (the scope focus IS the repo scope)', () => {
    const prompt = material.buildWorkerPrompt('cost — src/usage.js', TOOL_NAMES);
    assert.match(prompt, /Focus this review on the following scope[^]*cost — src\/usage\.js/);
    assert.match(prompt, /PRE-EXISTING issues in any file ARE in scope/);
  });
});

// ── scout prompts — adaptive by grouping, never by a counted threshold ────────────────────────────

describe('scout prompts carry no size threshold', () => {
  const prScout = buildPrScoutInput({ changedPaths: ['src/a.js', 'src/b.js'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
  const repoScout = buildRepoScoutInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;

  test('both tie the scope count to the number of concerns, never a target number', () => {
    assert.match(prScout, /number of scopes EQUALS the number of distinct concerns/);
    assert.match(repoScout, /number of scopes EQUALS the number of distinct concerns/);
  });

  test('both fold boundary review INTO a scope rather than emitting a scope per import edge', () => {
    // The 25-scope explosion came from a separate boundary scope per importing pair; the rule now
    // reviews boundaries from inside a scope, so the count stays linear in concerns.
    assert.match(prScout, /do NOT create a separate scope for a boundary/);
    assert.match(repoScout, /do NOT create a separate scope for a boundary/);
    assert.match(prScout, /ALSO read the files this group imports/);
  });

  test('the PR scout assigns changed files to scopes (files field); the repo scout does not', () => {
    // PR mode partitions the diff so each worker reads only its files; repo mode has no diff to assign.
    // The contract describes the fields to provide rather than asserting an exact count — the tool
    // schema always makes files optional, so "exactly two/three fields" would misrepresent it.
    assert.match(prScout, /files: the array of changed file paths this scope owns/);
    assert.doesNotMatch(repoScout, /files: the array of changed file paths/);
    assert.doesNotMatch(prScout, /exactly (two|three) fields/);
  });

  test('both forward the engine tool identifiers (incl. add_scope), never hardcoded names', () => {
    const custom = { requestChange: 'tool_rc', finishReview: 'tool_fr', addScope: 'tool_as' };
    const p = buildPrScoutInput({ changedPaths: ['src/a.js'], toolNames: custom, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.match(p, /tool_fr/);
    assert.match(p, /tool_as/);
    assert.doesNotMatch(p, /mcp__review_collector__/);
  });

  test('a non-empty repo scope BOUNDS grouping to the focus, not a soft hint', () => {
    const focused = buildRepoScoutInput({ scope: 'the auth layer', excludePatterns: ['*.lock'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
    assert.match(focused, /focused this review on: the auth layer/);
    assert.match(focused, /ONLY for files inside that focus/);
    assert.doesNotMatch(focused, /follow the code outward/);
    assert.match(focused, /excluded patterns in any scope: \*\.lock/);
  });

  test('an empty repo scope puts the whole repository in bounds', () => {
    assert.match(repoScout, /Cover the whole repository/);
  });
});

// ── buildReviewInput focus value (the single-scope vs narrowed distinction) ───────────────────────

describe('buildReviewInput focus', () => {
  const FILES = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];

  test('empty focus renders no CONCENTRATE block (the broad whole-diff review)', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT);
    assert.doesNotMatch(prompt, /CONCENTRATE THIS REVIEW/);
  });

  test('a non-empty focus renders the CONCENTRATE block with the focus text', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, 'cost — src/usage.js');
    assert.match(prompt, /CONCENTRATE THIS REVIEW on one part of the change: cost — src\/usage\.js/);
  });

  test('the focus block orders the worker to report issues found ANYWHERE, not withhold out-of-scope ones', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, 'cost — src/usage.js');
    // Report everything: a real bug outside the scope is still recorded, dedup happens downstream.
    assert.match(prompt, /if you notice a genuine issue ANYWHERE in the diff, still record it/);
    assert.match(prompt, new RegExp(`still record it with ${TOOL_NAMES.requestChange}`));
    assert.match(prompt, /de-duplicated downstream/);
    // The old suppression sentence must be gone — it is what taught the model to self-censor.
    assert.doesNotMatch(prompt, /only flag issues that belong to that part/);
    assert.doesNotMatch(prompt, /Other parts are reviewed separately/);
  });
});

// ── buildReviewInput dependency assess directive — gated on owning the bumped go.mod ──────────────
// [LAW:dataflow-not-control-flow] The assess directive is a VALUE rendered from scopeFiles + the bump
// list: only the ONE worker whose assigned files include the bumped go.mod is asked to assess, so a
// single author records each module's judgment. Every other worker — and every non-dependency PR —
// renders nothing.
describe('buildReviewInput dependency assess directive', () => {
  const FILES = [{ filename: 'go.mod', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+require github.com/a/b v1.1.0' }];
  const BUMPS = [{ modulePath: 'github.com/a/b', from: 'v1.0.0', to: 'v1.1.0', resolved: true }];

  test('the go.mod-owning worker is told to call assess_dependency, naming the exact module', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, '', ['go.mod'], 'the note', BUMPS);
    assert.match(prompt, new RegExp(`call ${TOOL_NAMES.assessDependency}`));
    assert.match(prompt, /copying the module path VERBATIM: github\.com\/a\/b/);
  });

  test('a worker that does NOT own the go.mod gets no assess directive, even with bumps present', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, '', ['src/other.js'], 'the note', BUMPS);
    assert.doesNotMatch(prompt, new RegExp(`call ${TOOL_NAMES.assessDependency}`));
  });

  test('a nested go.mod (tools/go.mod) still triggers the directive for its owner', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, '', ['tools/go.mod'], 'the note', BUMPS);
    assert.match(prompt, new RegExp(`call ${TOOL_NAMES.assessDependency}`));
  });

  test('no bumps means no directive even for a go.mod owner (a non-dependency PR touching go.mod)', () => {
    const { prompt } = buildReviewInput(FILES, 0, TOOL_NAMES, REPO_ROOT, '', ['go.mod'], '', []);
    assert.doesNotMatch(prompt, new RegExp(`call ${TOOL_NAMES.assessDependency}`));
  });
});

// ── buildReviewInput surfaces unshowable files (patchless + budget-skipped) as ONE block ──────────
// A file GitHub returns without a patch (large/binary) and a file whose diff overran MAX_DIFF_CHARS are
// two instances of one type — "a changed file whose diff cannot be shown". Both must be named in the
// prompt with a read-in-full instruction so the worker reviews them via the finish_review summary,
// never silently dropped while the scout still assigns them to scopes. [LAW:no-silent-failure]
describe('buildReviewInput surfaces unshowable files', () => {
  test('a patchless file appears in the block with a read-in-full instruction and no diff fence', () => {
    const files = [{ filename: 'src/big.js', status: 'modified' }]; // no `patch` — GitHub omitted it
    const { prompt } = buildReviewInput(files, 0, TOOL_NAMES, REPO_ROOT);
    assert.match(prompt, /could not be shown \(too large or binary/);
    assert.match(prompt, new RegExp(`${REPO_ROOT}/src/big\\.js`));
    assert.match(prompt, new RegExp(`report any issues via the ${TOOL_NAMES.finishReview} summary`));
    assert.doesNotMatch(prompt, /```diff/); // nothing to show, so no diff fence
  });

  test('a budget-skipped file lands in the SAME block as a patchless file', () => {
    const big = '@@ -1,1 +1,400 @@\n' + Array.from({ length: 400 }, (_, i) => `+line ${i}`).join('\n');
    const files = [
      { filename: 'src/patchless.js', status: 'modified' },
      { filename: 'src/overbudget.js', status: 'modified', patch: big },
    ];
    // A tiny budget forces the patchable file to be skipped too.
    const { prompt } = buildReviewInput(files, 50, TOOL_NAMES, REPO_ROOT);
    assert.match(prompt, new RegExp(`${REPO_ROOT}/src/patchless\\.js`));
    assert.match(prompt, new RegExp(`${REPO_ROOT}/src/overbudget\\.js`));
  });

  test('a fully-shown diff renders no unshowable block', () => {
    const files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const x = 1;' }];
    const { prompt } = buildReviewInput(files, 0, TOOL_NAMES, REPO_ROOT);
    assert.doesNotMatch(prompt, /could not be shown/);
  });
});

// ── shipped prompts carry NO reviewed-repo layout (598.4) ─────────────────────────────────────────
// The action reviews arbitrary repos; the reviewed repo's layout is a fact of the INPUT, not a constant
// of the prompt. Baking THIS repo's directories (src/, scripts/) and filenames into the generic prompts
// taught weak models on consumer repos to read shallow (nothing "qualifies" for a full read) and to
// hallucinate groupings around files that do not exist there. These prompts must name invariant
// CATEGORIES, never this repo's instances of them. [FRAMING:representation]
describe('shipped prompts carry no reviewed-repo layout', () => {
  // Inputs deliberately carry NONE of the hunted tokens, so any src/|scripts/|dist/ match below can only
  // be baked-in template text — never echoed input. (This is the 598.3 discipline: test the template by
  // feeding it inputs free of what you are hunting.)
  const NEUTRAL_FILES = [{ filename: 'lib/thing.go', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+x := 1' }];
  const review = buildReviewInput(NEUTRAL_FILES, 0, TOOL_NAMES, REPO_ROOT).prompt;
  const prScout = buildPrScoutInput({ changedPaths: ['lib/thing.go', 'app/main.rb'], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;
  const repoScout = buildRepoScoutInput({ scope: '', excludePatterns: [], toolNames: TOOL_NAMES, reviewedRepoRoot: REPO_ROOT }).prompt;

  test('none of the three prompts hardcode a reviewed-repo path (src/, scripts/, dist/, or a src/*.js file)', () => {
    for (const [name, prompt] of [['review', review], ['prScout', prScout], ['repoScout', repoScout]]) {
      assert.doesNotMatch(prompt, /(?:src|scripts|dist)\//, `${name} prompt must not name this repo's directories`);
    }
  });

  test('the read instruction is layout-neutral: every changed code file, tests included', () => {
    assert.match(review, /every changed file that contains code/);
    assert.match(review, /Test files count: read them/);
    // The old layout-specific instruction must be gone.
    assert.doesNotMatch(review, /files under src/);
  });

  test('both scouts teach concern-grouping with abstract examples, not this repo\'s filenames', () => {
    assert.match(prScout, /the function that reads that table/);
    assert.match(prScout, /line-anchor parsing and a change to report rendering/);
    assert.match(repoScout, /a price table and the function that reads that table/);
    assert.match(repoScout, /line-anchor parsing and report rendering/);
  });
});
