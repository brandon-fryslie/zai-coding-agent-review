'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { LEDGER_MARKER, ledgerEntryBody, sumCostToday, readSpentToday, appendCost } = require('../src/index.js');
const { costMarker } = require('../src/usage');

// A machine-written ledger entry: the sentinel then the reused cost marker.
const entry = (usd, created_at) => ({ body: ledgerEntryBody({ basis: 'dollars', usd }), created_at });
const unknownEntry = (created_at) => ({ body: ledgerEntryBody({ basis: 'unpriced', reason: 'no-price' }), created_at });
// A review billed to Claude subscription quota: $0 spent, a known Anthropic list price.
const subscriptionEntry = (notionalUsd, created_at) => ({ body: ledgerEntryBody({ basis: 'subscription', notionalUsd }), created_at });

const ZERO_TALLIES = { billed: { usd: 0, count: 0, unknownCount: 0 }, notional: { usd: 0, count: 0, unknownCount: 0 } };

const NOON = new Date('2026-07-11T12:00:00Z'); // today (UTC) = 2026-07-11

describe('ledgerEntryBody', () => {
  test('leads with the sentinel, then the reused cost marker (one representation, not a second)', () => {
    assert.equal(
      ledgerEntryBody({ basis: 'dollars', usd: 0.05 }),
      `${LEDGER_MARKER}\n${costMarker({ basis: 'dollars', usd: 0.05 })}`,
    );
  });

  test('an unavailable cost writes an honest `unknown` marker, never a fabricated zero', () => {
    assert.equal(ledgerEntryBody({ basis: 'unpriced', reason: 'no-price' }), `${LEDGER_MARKER}\n<!-- agent-review-cost-usd:unknown -->`);
  });
});

describe('sumCostToday', () => {
  test('sums only entries dated today (UTC of now); yesterday and tomorrow are excluded', () => {
    const { billed } = sumCostToday([
      entry(0.10, '2026-07-11T03:00:00Z'), // today, early
      entry(0.20, '2026-07-11T23:59:59Z'), // today, late
      entry(9.99, '2026-07-10T23:59:59Z'), // yesterday — excluded
      entry(9.99, '2026-07-12T00:00:00Z'), // tomorrow — excluded
    ], NOON);
    assert.equal(Number(billed.usd.toFixed(2)), 0.30);
    assert.equal(billed.count, 2);
  });

  test('the day boundary is UTC, not local — an entry just after UTC midnight counts, just before does not', () => {
    // now is early in the UTC day; a negative-offset LOCAL tz would call the 23:59:59Z instant "today",
    // but UTC-day comparison does not — proving the filter is UTC.
    const earlyUtc = new Date('2026-07-11T00:30:00Z');
    const { billed } = sumCostToday([
      entry(0.10, '2026-07-11T00:00:01Z'), // today (UTC) — included
      entry(0.10, '2026-07-10T23:59:59Z'), // yesterday (UTC) — excluded
    ], earlyUtc);
    assert.equal(billed.count, 1);
  });

  test('[LAW:single-enforcer] a comment NOT leading with the sentinel is excluded even if it carries a cost marker (human quote)', () => {
    const humanQuote = { body: `I see the bot posts ${LEDGER_MARKER} ${costMarker({ basis: 'dollars', usd: 999 })} — my own note`, created_at: '2026-07-11T10:00:00Z' };
    const { billed } = sumCostToday([humanQuote], NOON);
    assert.equal(billed.usd, 0); // the human's $999 is NOT summed
    assert.equal(billed.count, 0);
    assert.equal(billed.unknownCount, 0); // not even counted as an entry — it is not one
  });

  test('leading whitespace before the sentinel is tolerated (trimStart)', () => {
    const { billed } = sumCostToday([
      { body: `\n  ${ledgerEntryBody({ basis: 'dollars', usd: 0.07 })}`, created_at: '2026-07-11T10:00:00Z' },
    ], NOON);
    assert.equal(billed.count, 1);
  });

  test('[LAW:no-silent-failure] a today entry with an unknown cost is counted as unknown, never dropped', () => {
    const { billed } = sumCostToday([
      entry(0.05, '2026-07-11T09:00:00Z'),
      unknownEntry('2026-07-11T10:00:00Z'),
    ], NOON);
    assert.equal(Number(billed.usd.toFixed(2)), 0.05);
    assert.equal(billed.count, 1);
    assert.equal(billed.unknownCount, 1); // the day's spend is an honest lower bound
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2: a subscription review contributes $0.00 to the
  // ledger DOLLAR total — so it cannot move the DAILY_BUDGET_USD gate — while its notional figure is
  // still recorded and readable. The evidence on the ticket: $63.59 of list price on one PR would
  // otherwise have rationed a budget against money nobody spent.
  test('a subscription entry contributes $0 to the day\'s dollars while its list price stays visible', () => {
    const { billed, notional } = sumCostToday([
      entry(0.05, '2026-07-11T09:00:00Z'),
      subscriptionEntry(63.59, '2026-07-11T10:00:00Z'),
    ], NOON);
    assert.equal(Number(billed.usd.toFixed(2)), 0.05);   // the subscription's $63.59 is NOT in here
    assert.equal(billed.count, 1);
    assert.equal(billed.unknownCount, 0);                // it is not an "unknown" spend either — it is zero
    assert.equal(notional.usd, 63.59);                   // and it is not suppressed: still reported
    assert.equal(notional.count, 1);
  });

  // [LAW:no-silent-failure] A subscription review whose list price was never reported is still $0 of
  // spend — its missing figure must not be laundered into the billed unknown count, which would make
  // the day's spend read as a lower bound when it is exactly known.
  test('a subscription entry with an unknown list price is notional-unknown, never billed-unknown', () => {
    const { billed, notional } = sumCostToday([subscriptionEntry(null, '2026-07-11T10:00:00Z')], NOON);
    assert.deepEqual(billed, { usd: 0, count: 0, unknownCount: 0 });
    assert.deepEqual(notional, { usd: 0, count: 0, unknownCount: 1 });
  });

  test('a non-string body is tolerated (skipped, not a crash)', () => {
    const { billed } = sumCostToday([{ body: null, created_at: '2026-07-11T10:00:00Z' }], NOON);
    assert.equal(billed.count, 0);
  });

  test('no comments yields zeroes', () => {
    assert.deepEqual(sumCostToday([], NOON), ZERO_TALLIES);
  });

  test('[LAW:no-silent-failure] a real ledger entry with a corrupt timestamp fails loud, never a silent wrong-day', () => {
    assert.throws(() => sumCostToday([entry(0.05, 'not-a-date')], NOON), /Invalid time value/);
  });

  test('a NON-ledger comment with a bad/absent timestamp is skipped by the sentinel gate first — no crash', () => {
    // The gate is checked before the date parse, so a stray human comment cannot red the run on its timestamp.
    const { billed } = sumCostToday([{ body: 'a human note', created_at: 'garbage' }], NOON);
    assert.equal(billed.count, 0);
  });
});

describe('readSpentToday', () => {
  const fakeOctokit = (pages) => ({
    rest: { issues: { listComments: async ({ page }) => ({ data: pages[page - 1] || [] }) } },
  });

  test('sums today across the ledger issue, filtering out other days', async () => {
    const octokit = fakeOctokit([[
      entry(0.05, '2026-07-11T08:00:00Z'),
      entry(0.03, '2026-07-11T09:00:00Z'),
      entry(9.99, '2026-07-10T09:00:00Z'), // yesterday — excluded
    ]]);
    const { billed } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(billed.usd.toFixed(2)), 0.08);
    assert.equal(billed.count, 2);
  });

  test('exhausts pagination — a full first page forces a second fetch (spend spans pages)', async () => {
    const full = Array.from({ length: 100 }, () => entry(0.01, '2026-07-11T08:00:00Z'));
    const octokit = fakeOctokit([full, [entry(0.01, '2026-07-11T08:00:00Z'), { body: 'human note', created_at: '2026-07-11T08:00:00Z' }]]);
    const { billed } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(billed.count, 101);
    assert.equal(Number(billed.usd.toFixed(2)), 1.01);
  });

  test('an empty ledger issue yields zeroes', async () => {
    assert.deepEqual(await readSpentToday(fakeOctokit([[]]), 'o', 'r', 42, NOON), ZERO_TALLIES);
  });

  test('the issue number is threaded to the API', async () => {
    const seen = [];
    const octokit = { rest: { issues: { listComments: async (args) => { seen.push(args.issue_number); return { data: [] }; } } } };
    await readSpentToday(octokit, 'o', 'r', 777, NOON);
    assert.deepEqual(seen, [777]);
  });
});

describe('appendCost', () => {
  const capturingOctokit = (calls) => ({
    rest: { issues: { createComment: async (args) => { calls.push(args); return { data: { id: 1 } }; } } },
  });

  test('posts exactly one comment carrying the sentinel + cost marker to the ledger issue', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, { basis: 'dollars', usd: 0.05 });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { owner: calls[0].owner, repo: calls[0].repo, issue_number: calls[0].issue_number },
      { owner: 'o', repo: 'r', issue_number: 42 },
    );
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n${costMarker({ basis: 'dollars', usd: 0.05 })}`);
  });

  test('an unavailable cost still appends an entry, marked unknown (a review happened; its cost is unknown)', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, { basis: 'unpriced', reason: 'not-reported' });
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n<!-- agent-review-cost-usd:unknown -->`);
  });

  // [LAW:dataflow-not-control-flow] The append is UNCONDITIONAL: a subscription review records an
  // entry like every other, and its exclusion from the day's dollars is the marker NAME, not a caller
  // that skips the append. Skipping would make the subscription's consumption invisible rather than
  // merely unbilled — the ticket names that as a BAD approach explicitly.
  test('a subscription review still appends an entry, carrying its notional marker', async () => {
    const calls = [];
    await appendCost(capturingOctokit(calls), 'o', 'r', 42, { basis: 'subscription', notionalUsd: 63.59 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, `${LEDGER_MARKER}\n<!-- agent-review-notional-usd:63.590000 -->`);
  });

  test('[LAW:no-silent-failure] an API error propagates — the module never swallows a failed append', async () => {
    const octokit = { rest: { issues: { createComment: async () => { throw new Error('403 issues:write missing'); } } } };
    await assert.rejects(() => appendCost(octokit, 'o', 'r', 42, { basis: 'dollars', usd: 0.05 }), /issues:write/);
  });

  test('round-trips through the ledger: an appended entry is summed by readSpentToday on the same day', async () => {
    const store = [];
    const octokit = {
      rest: {
        issues: {
          createComment: async ({ body }) => { store.push({ body, created_at: NOON.toISOString() }); return { data: {} }; },
          listComments: async ({ page }) => ({ data: page === 1 ? store : [] }),
        },
      },
    };
    await appendCost(octokit, 'o', 'r', 42, { basis: 'dollars', usd: 0.05 });
    await appendCost(octokit, 'o', 'r', 42, { basis: 'dollars', usd: 0.03 });
    const { billed } = await readSpentToday(octokit, 'o', 'r', 42, NOON);
    assert.equal(Number(billed.usd.toFixed(2)), 0.08);
    assert.equal(billed.count, 2);
  });
});
