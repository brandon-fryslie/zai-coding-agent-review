#!/usr/bin/env node
// Fail the build when a price source has gone too long without being re-verified against its vendor's
// pricing page. [LAW:single-enforcer]
//
// PRICES_PER_MILLION is the one representation in this codebase with NO machine source — it is copied
// by hand off pages that are HTML marketing, not a contract, so scraping them at review time would
// just be a second map with no guarantee. CLAUDE.md already said "update by hand, verify the dated
// source before trusting old figures", and that warning was correct and still not enough: DeepSeek
// repriced on 2026-08-16, every rate rose (the cache-hit class by 1114%), and for six weeks every
// review printed a confident, well-formatted, "est."-stamped figure understating the real bill ~3.6x.
// Nothing failed. Nothing warned. It was found only because a human noticed an $89/day invoice the
// reported numbers could not explain.
//
// So the thing that was missing is not information — it is CONSEQUENCE. A map only a human remembers
// to redraw is one that has already started lying, and the fix is to make the build refuse to be
// green while the redraw is overdue. [FRAMING:representation] [LAW:no-silent-failure]
//
// Why the signal lands HERE and not in the review footer a consumer reads: a consumer cannot fix this
// repo's table, so a runtime staleness note would be an apology delivered to someone with no remedy,
// while the stale state persisted. A red check reaches the maintainer, who is the only person who can
// open the pricing page — and a check that cannot be green while the table is overdue is what makes
// the footer's "est." claim honest BY CONSTRUCTION rather than at render time.
//
// What this deliberately does NOT do is change how anything is priced. An overdue source still prices
// every review exactly as before, because the figure it produces is very probably still right and
// withholding it would trade a small doubt for a certain loss. Staleness is a claim about the TABLE's
// provenance, not about any one review's arithmetic, and it is reported as its own fact rather than
// smuggled into a cost as an absence. [LAW:one-type-per-behavior]
//
// Usage: node scripts/check-price-freshness.js   (exit 0 fresh, exit 1 with the list when overdue)
'use strict';

const {
  PRICE_SOURCES,
  PRICE_VERIFICATION_MAX_AGE_DAYS,
  stalePriceSources,
} = require('../src/usage');

// [LAW:effects-at-boundaries] The one clock read. stalePriceSources is pure and takes this instant as
// a value, which is what lets a test assert the same rule at a named date with no clock at all.
const overdue = stalePriceSources(PRICE_SOURCES, new Date());

if (overdue.length === 0) {
  console.log(
    `price table: all ${PRICE_SOURCES.length} sources verified within ${PRICE_VERIFICATION_MAX_AGE_DAYS} days`);
  process.exit(0);
}

// The remedy is spelled out per source because the check is only as good as how cheap it makes the
// real verification. Naming the URL and the whole comparison — rates, tiers, windows AND days — is
// what keeps this from degrading into a date someone bumps without looking: a vendor that moves a peak
// boundary or drops a weekday drifts exactly as expensively as one that changes a number, and a reader
// told only to "check the prices" would miss it.
console.error(
  `Price table is overdue for verification: ${overdue.length} of ${PRICE_SOURCES.length} source(s) `
  + `unverified for more than ${PRICE_VERIFICATION_MAX_AGE_DAYS} days.\n`);

for (const { source, ageDays } of overdue) {
  console.error(`  ${source.vendor} — verifiedOn ${source.verifiedOn} (${ageDays} days ago)`);
  console.error(`    page:   ${source.url}`);
  console.error(`    models: ${Object.keys(source.models).join(', ')}`);
}

console.error(
  '\nFor each source above: open its page and compare EVERYTHING the group holds — every rate, and '
  + 'every tier\'s\nrates, hours and days-of-week. Correct what moved, then set that source\'s '
  + '`verifiedOn` in src/usage.js to\ntoday\'s date. Bumping the date without opening the page '
  + 'restores exactly the silence this check exists to break.');

process.exit(1);
