#!/usr/bin/env node
// Fail the build when a price source has gone too long without being re-verified against its vendor's
// pricing page. [LAW:single-enforcer]
//
// `PRICE_SOURCES` (src/usage.js) is the one representation in this codebase with NO machine source —
// it is copied by hand off pages that are HTML marketing, not a contract, so scraping them at review
// time would just be a second map with no guarantee. (`PRICES_PER_MILLION` is DERIVED from it and is
// nobody's edit target; a maintainer sent there would be editing the output of the thing that needs
// fixing.) CLAUDE.md already said "update by hand, verify the dated source before trusting old
// figures", and that warning was correct and still not enough: DeepSeek repriced on 2026-08-16, every
// rate rose (the cache-hit class by 1114%), and for six weeks every review printed a confident,
// well-formatted, "est."-stamped figure understating the real bill ~3.6x. Nothing failed. Nothing
// warned. It was found only because a human noticed an $89/day invoice the reported numbers could not
// explain.
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
// Usage: node scripts/check-price-freshness.js
//   exit 0  every source verified within the threshold
//   exit 1  any source overdue, OR carrying a verifiedOn dated in the future — both red, because both
//           mean a rate is being asserted that nobody has confirmed lately, and the second additionally
//           means the check would never have said so again.
'use strict';

const {
  PRICE_SOURCES,
  PRICE_VERIFICATION_MAX_AGE_DAYS,
  stalePriceSources,
} = require('../src/usage');

// [LAW:dataflow-not-control-flow] One line per reason a date can fail, selected by the reason the
// predicate already attached — never re-derived here from the sign of `ageDays`. The two failures need
// genuinely different sentences: an overdue source needs re-reading, a future-dated one needs its date
// corrected, and describing the second as "unverified for more than 30 days" would send the maintainer
// to fix the wrong thing while printing an age of "-30 days ago".
const STALE_LINE = {
  overdue: ({ source, ageDays }) =>
    `${source.vendor} — verified ${source.verifiedOn}, ${ageDays} days ago `
    + `(limit ${PRICE_VERIFICATION_MAX_AGE_DAYS})`,
  'future-dated': ({ source, ageDays }) =>
    `${source.vendor} — verified ${source.verifiedOn}, which is ${-ageDays} days in the FUTURE; `
    + 'a date ahead of the clock is never re-checked, so fix the date',
};

// [LAW:effects-at-boundaries] The one clock read. stalePriceSources is pure and takes this instant as
// a value, which is what lets a test assert the same rule at a named date with no clock at all.
const unfresh = stalePriceSources(PRICE_SOURCES, new Date());

// [LAW:no-silent-failure] `process.exitCode`, never `process.exit()`. console.log/error write
// ASYNCHRONOUSLY when stdout is a pipe — which it is under GitHub Actions, and under this file's own
// test — and `process.exit()` in the same tick can terminate the process before those writes flush.
// The failure that would produce is this mechanism's own worst case: a red check with its explanation
// truncated or missing, which is a build refusing to go green for no stated reason. Setting the code
// and falling off the end lets the streams drain first.
if (unfresh.length === 0) {
  console.log(
    `price table: all ${PRICE_SOURCES.length} sources verified within ${PRICE_VERIFICATION_MAX_AGE_DAYS} days`);
} else {
  // The remedy is spelled out per source because the check is only as good as how cheap it makes the
  // real verification. Naming the URL and the whole comparison — rates, tiers, windows AND days — is
  // what keeps this from degrading into a date someone bumps without looking: a vendor that moves a
  // peak boundary or drops a weekday drifts exactly as expensively as one that changes a number, and a
  // reader told only to "check the prices" would miss it.
  console.error(
    `Price table needs attention: ${unfresh.length} of ${PRICE_SOURCES.length} source(s) cannot be `
    + 'treated as verified.\n');

  for (const entry of unfresh) {
    console.error(`  ${STALE_LINE[entry.reason](entry)}`);
    console.error(`    page:   ${entry.source.url}`);
    console.error(`    models: ${Object.keys(entry.source.models).join(', ')}`);
  }

  console.error(
    '\nFor each source above: open its page and compare EVERYTHING the group holds — every rate, and '
    + 'every tier\'s\nrates, hours and days of week. Correct what moved, then set that source\'s '
    + '`verifiedOn` in src/usage.js to\ntoday\'s date. Bumping the date without opening the page '
    + 'restores exactly the silence this check exists to break.');

  process.exitCode = 1;
}
