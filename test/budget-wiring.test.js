'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { diffChurn } = require('../src/diff');
const {
  parseDailyBudgetUsd,
  defaultBudgetCandidates,
  estimatedCostUsd,
  UNLIMITED_EFFECTIVE_ROUNDS,
} = require('../src/budget');
const { defaultEffortProfile } = require('../src/effort');
const { resolveBudgetedEffort } = require('../src/run');
const { ledgerEntryBody } = require('../src/ledger');

// The churn axis the budget cost estimate is calibrated against: added + deleted content lines.
describe('diffChurn', () => {
  test('counts every added and deleted content line across files', () => {
    const files = [
      { filename: 'a.js', patch: '@@ -1,2 +1,3 @@\n context\n+added one\n+added two\n-removed one' },
      { filename: 'b.js', patch: '@@ -5,1 +5,1 @@\n-old\n+new' },
    ];
    // a.js: +2, -1 = 3; b.js: +1, -1 = 2 → 5
    assert.equal(diffChurn(files), 5);
  });

  test('the hunk header and no-newline marker are not content lines', () => {
    const files = [{ filename: 'a.js', patch: '@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file' }];
    assert.equal(diffChurn(files), 2);
  });

  test('a file with no patch (binary / rename-only) contributes zero', () => {
    assert.equal(diffChurn([{ filename: 'img.png' }, { filename: 'a.js', patch: '@@ -1 +1 @@\n+x' }]), 1);
  });

  test('an empty file set is zero churn', () => {
    assert.equal(diffChurn([]), 0);
  });
});

// [LAW:no-silent-failure] The off state (unset/0) is a value, not an error; a malformed budget reds loud.
describe('parseDailyBudgetUsd', () => {
  test('unset / empty / whitespace is the OFF value 0', () => {
    assert.equal(parseDailyBudgetUsd(''), 0);
    assert.equal(parseDailyBudgetUsd('   '), 0);
    assert.equal(parseDailyBudgetUsd(undefined), 0);
  });

  test('a well-formed non-negative number parses', () => {
    assert.equal(parseDailyBudgetUsd('0'), 0);
    assert.equal(parseDailyBudgetUsd('10'), 10);
    assert.equal(parseDailyBudgetUsd('2.5'), 2.5);
  });

  test('a malformed or negative value throws — never a silent fall-back to off', () => {
    assert.throws(() => parseDailyBudgetUsd('abc'), /Invalid DAILY_BUDGET_USD/);
    assert.throws(() => parseDailyBudgetUsd('-1'), /Invalid DAILY_BUDGET_USD/);
    assert.throws(() => parseDailyBudgetUsd('1e999'), /Invalid DAILY_BUDGET_USD/); // Infinity
  });
});

// The ceiling invariant: budget only ever CAPS effort, never raises it above the configured profile.
describe('defaultBudgetCandidates', () => {
  test('the configured profile is always the most expensive candidate (budget never raises effort)', () => {
    const top = defaultEffortProfile({ roundCap: 5 });
    const candidates = defaultBudgetCandidates(top);
    // Behavioral (not identity): the configured ceiling is offered as a candidate — asserted by value so
    // a future copy (`{ ...topProfile }`) that preserves behavior doesn't break the test.
    assert.ok(candidates.some((c) => c.roundCap === top.roundCap && c.sweepCap === top.sweepCap));
    const maxEst = Math.max(...candidates.map((c) => estimatedCostUsd(c, 100)));
    assert.equal(estimatedCostUsd(top, 100), maxEst);
  });

  test('offers cheaper de-rated rungs strictly below the ceiling', () => {
    const caps = defaultBudgetCandidates(defaultEffortProfile({ roundCap: 5 })).map((c) => c.roundCap).sort((a, b) => a - b);
    assert.deepEqual(caps, [1, 2, 3, 5]);
  });

  test('a low ceiling drops rungs that would exceed it — never above the user cap', () => {
    // roundCap 2 → only rung 1 is strictly cheaper; top (2) is the ceiling.
    const caps = defaultBudgetCandidates(defaultEffortProfile({ roundCap: 2 })).map((c) => c.roundCap).sort((a, b) => a - b);
    assert.deepEqual(caps, [1, 2]);
  });

  test('the 0="unlimited" ceiling ranks above every finite rung (de-rates unlimited to bounded)', () => {
    const top = defaultEffortProfile({ roundCap: 0 });
    const candidates = defaultBudgetCandidates(top);
    // Every de-rated rung is finite and cheaper than the unlimited top.
    assert.ok(candidates.some((c) => c.roundCap === 0)); // the unlimited top is present
    for (const c of candidates) {
      if (c.roundCap !== 0) assert.ok(c.roundCap < UNLIMITED_EFFECTIVE_ROUNDS);
    }
  });

  test('de-rating preserves the profile\'s other axes (only roundCap moves)', () => {
    const top = defaultEffortProfile({ roundCap: 5 });
    for (const c of defaultBudgetCandidates(top)) {
      assert.equal(c.sweepCap, top.sweepCap);
    }
  });
});

// The boundary glue: read the ledger, choose the affordable profile, and — critically — fall back
// SPEND-SAFE when the read fails. [LAW:no-silent-failure]
describe('resolveBudgetedEffort', () => {
  const today = new Date('2026-07-11T12:00:00Z');
  const smallDiff = [{ filename: 'a.js', patch: '@@ -1 +1 @@\n+x' }]; // churn 1
  const defaultEffort = defaultEffortProfile({ roundCap: 5 });
  // The proposal is decided UPSTREAM and passed in; the budget path only caps it. Here that proposal is
  // the default de-rate ladder (difficulty scaling off), exactly what the run() seam passes when off.
  const candidates = defaultBudgetCandidates(defaultEffort);

  const fakeOctokit = (comments, { throwOnRead = false } = {}) => ({
    rest: {
      issues: {
        listComments: async () => {
          if (throwOnRead) throw new Error('boom');
          return { data: comments };
        },
      },
    },
  });

  // The config each ledger entry was written under — ledgerEntryBody records its model and endpoint
  // host beside the figure. What the gate rations on is the figure's BASIS, so one config serves both.
  const LEDGER_CONFIG = {
    name: 'deepseek',
    engine: 'claude-code',
    model: 'deepseek-v4-pro',
    endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', credential: { kind: 'api-key', value: 'k' } },
  };
  const ledgerUsage = (cost) => ({ tokens: { inputCacheMiss: 10, inputCacheHit: 0, output: 5 }, cost });
  const ledgerComment = (usd, created_at) => ({ body: ledgerEntryBody(ledgerUsage({ basis: 'dollars', usd }), LEDGER_CONFIG), created_at });
  const subscriptionLedgerComment = (notionalUsd, created_at) => ({ body: ledgerEntryBody(ledgerUsage({ basis: 'subscription', notionalUsd }), LEDGER_CONFIG), created_at });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2, end to end through the seam that actually
  // rations. The two halves of this test are the SAME day and the SAME dollar figure, differing only
  // in what paid for it — which is exactly the fact the old two-arm cost type could not represent.
  // Real spend of $63.59 against a $10 budget throttles to the floor; $63.59 of Anthropic LIST PRICE
  // billed to plan quota must not move the gate at all, because no money was spent.
  // The evidence on the ticket: reviewing PR #113 reported $63.59 across four subscription rounds.
  test('subscription list price does not throttle the budget; the same figure in real dollars does', async () => {
    const budgeted = (comments) => resolveBudgetedEffort({
      octokit: fakeOctokit(comments), owner: 'o', repo: 'r', issueNumber: 1, now: today,
      filteredFiles: smallDiff, candidates, dailyBudget: 10,
    });
    const spent = await budgeted([ledgerComment(63.59, '2026-07-11T08:00:00Z')]);
    const quota = await budgeted([subscriptionLedgerComment(63.59, '2026-07-11T08:00:00Z')]);
    assert.equal(quota.roundCap, 5, 'a quota-billed day must leave the full budget available');
    assert.ok(spent.roundCap < quota.roundCap, `real overspend must throttle: spent=${spent.roundCap} quota=${quota.roundCap}`);
    // And the control: an empty day and a quota-only day are indistinguishable to the gradient.
    assert.equal(quota.roundCap, (await budgeted([])).roundCap);
  });

  test('ample remaining budget chooses the full configured effort (the ceiling)', async () => {
    const octokit = fakeOctokit([]); // nothing spent today
    const profile = await resolveBudgetedEffort({
      octokit, owner: 'o', repo: 'r', issueNumber: 1, now: today,
      filteredFiles: smallDiff, candidates, dailyBudget: 100,
    });
    assert.equal(profile.roundCap, 5);
  });

  test('the gradient is monotone: a shrinking budget never raises the chosen effort', async () => {
    // Calibration-INDEPENDENT: chooseProfile is monotone in the per-review cap, so across a descending
    // budget sweep the chosen roundCap is non-increasing — the gradient's actual shape. Asserting the
    // shape (monotone down) instead of a numeric threshold keeps the test robust to recalibration of the
    // cost constants; the ample→ceiling and floor→cheapest endpoints are pinned by the neighbouring tests.
    const caps = [];
    for (const dailyBudget of [100, 10, 2, 0.5, 0.05]) {
      const profile = await resolveBudgetedEffort({
        octokit: fakeOctokit([]), owner: 'o', repo: 'r', issueNumber: 1, now: today,
        filteredFiles: smallDiff, candidates, dailyBudget,
      });
      caps.push(profile.roundCap);
    }
    for (let i = 1; i < caps.length; i++) {
      assert.ok(caps[i] <= caps[i - 1], `roundCap rose as the budget shrank: ${JSON.stringify(caps)}`);
    }
  });

  test('[LAW:no-silent-failure] a failed ledger read falls back SPEND-SAFE (full effort), never a silent throttle', async () => {
    const octokit = fakeOctokit([], { throwOnRead: true });
    const profile = await resolveBudgetedEffort({
      octokit, owner: 'o', repo: 'r', issueNumber: 1, now: today,
      filteredFiles: smallDiff, candidates, dailyBudget: 100,
    });
    // Spend-safe = proceed as if under budget = full effort, despite the read failure.
    assert.equal(profile.roundCap, 5);
  });

  test('[LAW:behavior-not-structure] the budget FLOOR still returns a runnable profile — a minimal review always runs', async () => {
    // Fully-exhausted budget + a large-churn diff so even the cheapest rung (roundCap 1) exceeds the
    // floored per-review cap (MIN_CAP_USD $0.10): perRoundBase(~300 churn) ≈ $0.126 > $0.10. This forces
    // chooseProfile's withinCap=false branch. The guarantee under test: the helper never throws or
    // returns null on the floor — it returns the cheapest candidate, so a minimal review always runs.
    const bigDiff = [{ filename: 'big.js', patch: '@@ -1 +1 @@\n' + '+x\n'.repeat(300) }]; // churn ~300
    const octokit = fakeOctokit([ledgerComment(0.05, '2026-07-11T08:00:00Z')]); // day already over its $0.01 budget
    const profile = await resolveBudgetedEffort({
      octokit, owner: 'o', repo: 'r', issueNumber: 1, now: today,
      filteredFiles: bigDiff, candidates, dailyBudget: 0.01,
    });
    // The cheapest rung is returned despite nothing fitting the cap — the floor fallback ran.
    assert.equal(profile.roundCap, 1);
  });

  test('only today\'s ledger entries count toward the day\'s spend', async () => {
    // A big spend YESTERDAY must not throttle today: the read sums only today's UTC entries.
    const octokit = fakeOctokit([ledgerComment(999, '2026-07-10T23:00:00Z')]);
    const profile = await resolveBudgetedEffort({
      octokit, owner: 'o', repo: 'r', issueNumber: 1, now: today,
      filteredFiles: smallDiff, candidates, dailyBudget: 100,
    });
    assert.equal(profile.roundCap, 5);
  });
});

// ── warnBudgetExhausted distinguishes a coverage gap from curtailed sweeps (zai-timing-sn1 r2) ────
describe('warnBudgetExhausted', () => {
  const { warnBudgetExhausted } = require('../src/run');
  const core = require('@actions/core');
  function captured(review) {
    const original = core.warning;
    const warnings = [];
    core.warning = m => warnings.push(m);
    try { warnBudgetExhausted(review); } finally { core.warning = original; }
    return warnings;
  }
  test('a coverage gap names the unreviewed scopes', () => {
    const w = captured({ budgetExhausted: true, unreviewedScopes: ['store', 'docs'] });
    assert.equal(w.length, 1);
    assert.match(w[0], /2 scope\(s\) went unreviewed \(store, docs\)/);
    assert.match(w[0], /TIME_BUDGET_MINUTES/);
  });
  test('curtailed-only says every scope was reviewed — never a contradictory zero-unreviewed line', () => {
    const w = captured({ budgetExhausted: true, unreviewedScopes: [] });
    assert.equal(w.length, 1);
    assert.match(w[0], /every scope was reviewed, but convergence sweeps were cut short/);
    assert.doesNotMatch(w[0], /0 scope\(s\)/);
  });
  test('a budget that never bit warns nothing', () => {
    assert.deepEqual(captured({ budgetExhausted: false, unreviewedScopes: [] }), []);
  });
});
