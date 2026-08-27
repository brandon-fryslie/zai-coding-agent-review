'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRICE_SOURCES,
  PRICE_VERIFICATION_MAX_AGE_DAYS,
  stalePriceSources,
} = require('../src/usage');

const DAY_MS = 86_400_000;

// A price source shaped like the shipped ones but owned by this file, so back-dating a verification is
// a value the test constructs rather than a mutation of the real table. [LAW:no-shared-mutable-globals]
const sourceVerifiedOn = verifiedOn => ({
  vendor: 'Testco',
  url: 'https://example.invalid/pricing',
  verifiedOn,
  models: { 'test-model': { tiers: [{ when: [], rates: { input: 1, cachedInput: 0.1, output: 2 } }] } },
});

const NOW = new Date('2026-08-26T12:00:00.000Z');
const daysBefore = n => new Date(NOW.getTime() - n * DAY_MS).toISOString().slice(0, 10);

// --- the predicate (zai-cost-truth-p5o.3) ---

describe('stalePriceSources', () => {
  // [LAW:verifiable-goals] THE ACCEPTANCE CRITERION, both directions: a back-dated source is reported,
  // a freshly-dated one is not, at an instant the test names so the answer never depends on the clock.
  test('a source verified beyond the threshold is reported, with its age', () => {
    const stale = stalePriceSources([sourceVerifiedOn(daysBefore(75))], NOW);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].source.vendor, 'Testco');
    assert.equal(stale[0].ageDays, 75);
    assert.equal(stale[0].reason, 'overdue');
  });

  test('a source verified within the threshold is not reported', () => {
    assert.deepEqual(stalePriceSources([sourceVerifiedOn(daysBefore(3))], NOW), []);
  });

  test('the threshold boundary is exact: at the limit fresh, one day past it stale', () => {
    const at = n => stalePriceSources([sourceVerifiedOn(daysBefore(n))], NOW).length;
    assert.equal(at(PRICE_VERIFICATION_MAX_AGE_DAYS), 0);
    assert.equal(at(PRICE_VERIFICATION_MAX_AGE_DAYS + 1), 1);
  });

  test('only the overdue sources are reported — a fresh neighbour is left alone', () => {
    const stale = stalePriceSources(
      [sourceVerifiedOn(daysBefore(1)), sourceVerifiedOn(daysBefore(200))], NOW);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].ageDays, 200);
  });

  // Freshness is a bounded interval, not "not too old". A date in the future is a typo or a date
  // bumped without opening the page, and a one-sided test would score it fresh forever — silencing
  // the check permanently, which is the failure this whole mechanism exists to end.
  test('a verifiedOn dated in the future is reported, not treated as permanently fresh', () => {
    const ahead = new Date(NOW.getTime() + 30 * DAY_MS).toISOString().slice(0, 10);
    assert.equal(stalePriceSources([sourceVerifiedOn(ahead)], NOW).length, 1);
  });

  // The two failures carry different remedies — re-read the page vs. fix the date — so the reason
  // travels with the age rather than being re-derived from its sign by whoever renders it.
  test('the reason distinguishes a future date from an overdue one', () => {
    const ahead = new Date(NOW.getTime() + 30 * DAY_MS).toISOString().slice(0, 10);
    assert.equal(stalePriceSources([sourceVerifiedOn(ahead)], NOW)[0].reason, 'future-dated');
    assert.equal(stalePriceSources([sourceVerifiedOn(daysBefore(90))], NOW)[0].reason, 'overdue');
  });

  // [LAW:no-silent-failure] An unreadable date yields a NaN age, and NaN is younger than every
  // threshold — so a typo would score that source fresh forever rather than loudly.
  test('an unreadable verifiedOn throws rather than scoring as fresh', () => {
    for (const bad of ['26-08-01', '2026-8-1', 'yesterday', '', undefined, '2026-13-45']) {
      assert.throws(() => stalePriceSources([sourceVerifiedOn(bad)], NOW), /unreadable verifiedOn/);
    }
  });

  test('the current instant must be a Date: a missing or invalid one throws', () => {
    const sources = [sourceVerifiedOn(daysBefore(1))];
    assert.throws(() => stalePriceSources(sources), /current instant/);
    assert.throws(() => stalePriceSources(sources, new Date('nonsense')), /current instant/);
    assert.throws(() => stalePriceSources(sources, '2026-08-26'), /current instant/);
  });
});

// --- the shipped table's own shape ---

describe('PRICE_SOURCES', () => {
  // The grouping exists so a rate cannot be added without a page and a date to check it against.
  test('every source names a vendor, a URL and a readable verification date, and prices something', () => {
    for (const source of PRICE_SOURCES) {
      assert.ok(source.vendor, 'a source must name its vendor');
      assert.match(source.url, /^https:\/\//, `${source.vendor} must name its pricing page`);
      assert.match(source.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${source.vendor} verifiedOn`);
      assert.ok(Object.keys(source.models).length > 0, `${source.vendor} prices no models`);
    }
  });

  // Deliberately NOT an assertion that the shipped table is fresh right now: that rule has one
  // enforcer, scripts/check-price-freshness.js, and asserting it here too would red every unrelated
  // test run for a reason that has nothing to do with whether the code works. [LAW:single-enforcer]
  test('no model is priced by two sources', () => {
    const seen = new Set();
    for (const source of PRICE_SOURCES) {
      for (const model of Object.keys(source.models)) {
        assert.ok(!seen.has(model), `${model} is priced by more than one source`);
        seen.add(model);
      }
    }
  });
});

// --- the sink: the check actually reds (zai-cost-truth-p5o.3) ---

// The mechanism's entire value is the RED, so the exit code is asserted against the real script rather
// than inferred from the predicate — otherwise an inverted exit test-passes forever. The script reads
// the clock at its boundary by design, so the test supplies a fake one through a `--require` preload
// it writes itself: no seam is added to production code for the test's benefit.
// [LAW:behavior-not-structure]
const FAKE_CLOCK = `
'use strict';
const Real = Date;
const FIXED = Real.parse(process.env.FAKE_NOW);
class Fake extends Real {
  constructor(...args) { super(...(args.length ? args : [FIXED])); }
  static now() { return FIXED; }
}
globalThis.Date = Fake;
`;

function runCheckAt(at) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-freshness-'));
  const preload = path.join(dir, 'fake-clock.js');
  fs.writeFileSync(preload, FAKE_CLOCK);
  const script = path.resolve(__dirname, '../scripts/check-price-freshness.js');
  try {
    const stdout = execFileSync(process.execPath, ['--require', preload, script], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_NOW: at.toISOString() },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    return { code: err.status, output: `${err.stdout}${err.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Both instants are DERIVED from the shipped dates rather than written down, so neither rots the next
// time a source is re-verified.
const newestVerification = Math.max(
  ...PRICE_SOURCES.map(s => Date.parse(`${s.verifiedOn}T00:00:00Z`)));

describe('check-price-freshness.js', () => {
  test('exits non-zero and names every overdue source once the threshold has passed', () => {
    const past = new Date(newestVerification + (PRICE_VERIFICATION_MAX_AGE_DAYS + 1) * DAY_MS + 3_600_000);
    const { code, output } = runCheckAt(past);
    assert.equal(code, 1);
    assert.match(output, /cannot be treated as verified/);
    assert.match(output, /days ago/);
    for (const source of PRICE_SOURCES) {
      assert.match(output, new RegExp(source.vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.ok(output.includes(source.url), `${source.vendor}'s page must be named`);
    }
    // The remedy has to name the WHOLE comparison. A vendor moving a peak boundary or dropping a
    // weekday drifts as expensively as one changing a number, and a reader told only to check the
    // prices would re-date the source without looking at its windows.
    assert.match(output, /days of week|days-of-week/);
  });

  // A clock behind every verification date makes every source future-dated. The report must say so
  // rather than describing them as under-verified and printing a negative age — the remedy is to fix
  // the date, not to re-read the page, and a check that names the wrong defect wastes the one thing it
  // was built to buy.
  test('a future-dated source is reported as such, never as an age of "-N days ago"', () => {
    const before = new Date(Math.min(
      ...PRICE_SOURCES.map(s => Date.parse(`${s.verifiedOn}T00:00:00Z`))) - 5 * DAY_MS);
    const { code, output } = runCheckAt(before);
    assert.equal(code, 1);
    assert.match(output, /in the FUTURE/);
    assert.doesNotMatch(output, /-\d+ days ago/);
  });

  test('exits zero while every source is inside the threshold', () => {
    // Valid whenever the shipped sources sit within one threshold of each other — which is exactly
    // what a green check on this repo guarantees.
    const { code, output } = runCheckAt(new Date(newestVerification + 3_600_000));
    assert.equal(code, 0);
    assert.match(output, /verified within/);
  });
});
