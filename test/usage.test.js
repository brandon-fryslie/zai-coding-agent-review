'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractUsage: codexExtractUsage } = require('../src/engine/codex');
const { extractUsage: claudeExtractUsage } = require('../src/engine/claude-code');
const {
  priceFromTable,
  ratesAt,
  spawnFromTokens,
  totalInputTokens,
  renderCostLine,
  renderPrTotal,
  costMarker,
  parseCostMarker,
  parseCost,
  parseCostRecord,
  providerIdentity,
  sumCost,
  costWarning,
  formatTokenCount,
  PRICES_PER_MILLION,
} = require('../src/usage');

const CODEX_CONFIG = {
  name: 'codex-mini',
  engine: 'codex',
  model: 'gpt-5.4-mini',
  endpoint: { apiType: 'openai-responses', baseUrl: 'https://api.openai.com/v1', credential: { kind: 'api-key', value: 'sk-x' } },
};

const ZAI_CONFIG = {
  name: 'zai-glm',
  engine: 'claude-code',
  model: 'glm-5.1',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic', credential: { kind: 'api-key', value: 'k' } },
};

const DEEPSEEK_CONFIG = {
  name: 'deepseek',
  engine: 'claude-code',
  model: 'deepseek-v4-pro',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', credential: { kind: 'api-key', value: 'k' } },
};

// A genuine Anthropic endpoint — the only case where claude-code's total_cost_usd is a usable cost.
const ANTHROPIC_CONFIG = {
  name: 'anthropic',
  engine: 'claude-code',
  model: 'claude-x',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } },
};

// The SAME Anthropic host, paid for differently: an oauth credential means plan quota, not dollars.
// The only difference from ANTHROPIC_CONFIG is credential.kind — which is exactly the fact that
// decides the cost basis, so this pair is what proves the basis follows the credential and not the
// hostname. PRESETS pins every oauth row to this baseUrl (assertPresetsSafe), so no other host can
// reach this shape.
const SUBSCRIPTION_CONFIG = {
  name: 'claude-subscription',
  engine: 'claude-code',
  model: 'claude-sonnet-5',
  endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', credential: { kind: 'oauth', value: 'sk-ant-oat01-x' } },
};

// The prior-round tallies summarizePriorReviews returns: one tally per basis, reported side by side
// and never added. Defaults are all-zero so each test names only the numbers it is actually about.
const prior = ({ usd = 0, count = 0, unknownCount = 0, notionalUsd = 0, notionalCount = 0, notionalUnknownCount = 0 } = {}) => ({
  billed: { total: usd, count, unknownCount },
  notional: { total: notionalUsd, count: notionalCount, unknownCount: notionalUnknownCount },
});

// The two instants the fixtures below are priced at. DeepSeek's schedule is 01:00-04:00 and
// 06:00-10:00 UTC, Monday through Friday, so these sit on opposite tiers of the same week — and
// OFF_PEAK is a Saturday, which is off-peak by DAY at an hour that would be peak on a weekday.
// Every flat-rate model prices identically at either, which is the point: only the schedule varies.
const OFF_PEAK = new Date('2026-08-22T02:30:00.000Z'); // Saturday 02:30 UTC
const PEAK = new Date('2026-08-20T02:30:00.000Z');     // Thursday 02:30 UTC

// priceFromTable returns THE COST VALUE, so these two read the arm a test is actually about and fail
// loudly on the other. Asserting the basis here is what keeps `usd` from silently reading `undefined`
// off an unpriced result and comparing it to a number.
// These build the spawn the way an engine adapter does — through spawnFromTokens, so what they
// exercise is what production can actually prove about a spawn, never a context nobody could observe.
const usd = (tokens, model, at) => {
  const cost = priceFromTable(spawnFromTokens(at, tokens), model);
  assert.equal(cost.basis, 'dollars', `expected a priced result, got ${JSON.stringify(cost)}`);
  return cost.usd;
};
const unpriced = (tokens, model, at) => {
  const cost = priceFromTable(spawnFromTokens(at, tokens), model);
  assert.equal(cost.basis, 'unpriced', `expected an unpriced result, got ${JSON.stringify(cost)}`);
  return cost.reason;
};

// --- priceFromTable ---

describe('priceFromTable', () => {
  test('prices non-cached input, cached input, and output at their distinct rates', () => {
    // gpt-5.4-mini: input 0.75, cachedInput 0.075, output 4.50 (per 1M).
    // 6,000 non-cached in @0.75 + 4,000 cached @0.075 + 2,000 out @4.50 = 13,800 / 1e6.
    const cost = usd({ inputCacheMiss: 6_000, inputCacheHit: 4_000, output: 2_000 }, 'gpt-5.4-mini', OFF_PEAK);
    assert.ok(Math.abs(cost - 0.0138) < 1e-9, `expected ~0.0138, got ${cost}`);
  });

  test('a non-finite result (NaN token count) is unpriced, never a NaN cost', () => {
    assert.equal(unpriced({ inputCacheMiss: NaN, inputCacheHit: 0, output: 2_000 }, 'gpt-5.4-mini', OFF_PEAK), 'schedule-gap');
  });

  test('treats absent cached tokens as zero (all input billed at full rate)', () => {
    // gpt-5.5 prices only up to 272K context, so this stays inside that card deliberately:
    // 200k non-cached @5.00 = 1.00.
    assert.equal(usd({ inputCacheMiss: 200_000, inputCacheHit: 0, output: 0 }, 'gpt-5.5', OFF_PEAK), 1.00);
  });

  test('prices deepseek and glm models from the same table (one mechanism, every provider)', () => {
    // deepseek-v4-pro off-peak: input 0.66, output 1.98. 1M in + 1M out = 0.66 + 1.98 = 2.64.
    const ds = usd({ inputCacheMiss: 1_000_000, inputCacheHit: 0, output: 1_000_000 }, 'deepseek-v4-pro', OFF_PEAK);
    assert.ok(Math.abs(ds - 2.64) < 1e-9, `deepseek: got ${ds}`);
    // glm-5.1: input 1.40, cachedInput 0.26, output 4.40. 800k non-cached @1.40 + 200k @0.26 + 100k out @4.40.
    const glm = usd({ inputCacheMiss: 800_000, inputCacheHit: 200_000, output: 100_000 }, 'glm-5.1', OFF_PEAK);
    const expected = (800_000 * 1.40 + 200_000 * 0.26 + 100_000 * 4.40) / 1e6;
    assert.ok(Math.abs(glm - expected) < 1e-9, `glm: got ${glm}`);
  });

  test('a model with no price-table entry is unpriced as no-price — never a fabricated zero', () => {
    assert.equal(unpriced({ inputCacheMiss: 100, inputCacheHit: 0, output: 100 }, 'gpt-unknown', OFF_PEAK), 'no-price');
  });

  // [LAW:no-silent-failure] The two causes are told apart, because their remedies differ: one says
  // add the model, the other says the model is there and its schedule declines this spawn. Collapsing
  // them would send a maintainer to edit a table that is already correct.
  test('a listed model whose schedule covers no card reads schedule-gap, not no-price', () => {
    assert.equal(unpriced({ inputCacheMiss: 900_000, inputCacheHit: 0, output: 0 }, 'gpt-5.5', OFF_PEAK), 'schedule-gap');
  });

  test('a model named after an inherited property is absent from the table, not a schedule', () => {
    // A model id is a config value, so it can be any string. A bare index answers Object.prototype's
    // own members for these, which is truthy and is not a schedule — the lookup must ask about own
    // keys or a review dies reading `.tiers` off a function.
    const tokens = { inputCacheMiss: 100, inputCacheHit: 0, output: 100 };
    for (const model of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(unpriced(tokens, model, OFF_PEAK), 'no-price', `${model} must price as unknown`);
    }
  });

  test('every default model the providers ship has a price-table entry', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'deepseek-v4-pro', 'glm-5.1']) {
      assert.ok(PRICES_PER_MILLION[model], `missing price for ${model}`);
    }
  });
});

// --- the price table is a SCHEDULE (zai-cost-truth-p5o.1) ---

describe('time-varying rates', () => {
  const TOKENS = { inputCacheMiss: 2_000_000, inputCacheHit: 24_000_000, output: 600_000 };

  // [LAW:verifiable-goals] THE ACCEPTANCE CRITERION. One identical usage record, two instants, and
  // the only thing that differs is which side of the schedule they fall on. The 2x is ASSERTED here
  // rather than encoded in the table as a multiplier, so this test can still fail the day a vendor
  // prices its tiers independently — which is exactly what a table-drift test is for.
  test('the same tokens cost exactly 2x at a peak instant as at an off-peak one', () => {
    const offPeak = usd(TOKENS, 'deepseek-v4-pro', OFF_PEAK);
    const peak = usd(TOKENS, 'deepseek-v4-pro', PEAK);
    assert.ok(Math.abs(peak - offPeak * 2) < 1e-9, `off-peak ${offPeak}, peak ${peak}`);
  });

  test('the weekend is off-peak at an hour that is peak on a weekday', () => {
    // Same hour-of-day, one Saturday and one Thursday. Peak is Monday-Friday, so the day is as
    // load-bearing as the hour — a schedule holding only hours would double-charge every weekend run.
    assert.equal(OFF_PEAK.getUTCHours(), PEAK.getUTCHours());
    assert.ok(usd(TOKENS, 'deepseek-v4-pro', OFF_PEAK) < usd(TOKENS, 'deepseek-v4-pro', PEAK));
  });

  test('a boundary instant belongs to the window that starts there, not the one that ends there', () => {
    const inPeak = usd(TOKENS, 'deepseek-v4-pro', new Date('2026-08-20T03:59:59.000Z'));
    const atFour = usd(TOKENS, 'deepseek-v4-pro', new Date('2026-08-20T04:00:00.000Z'));
    const atOne = usd(TOKENS, 'deepseek-v4-pro', new Date('2026-08-20T01:00:00.000Z'));
    assert.equal(atFour, usd(TOKENS, 'deepseek-v4-pro', OFF_PEAK));
    assert.equal(atOne, inPeak);
  });

  test('a flat-rate model prices identically at every instant — an empty schedule, not a special case', () => {
    const at = t => usd(TOKENS, 'gpt-5.4-mini', t);
    assert.equal(at(PEAK), at(OFF_PEAK));
    assert.equal(at(PEAK), at(new Date('2026-08-20T07:15:00.000Z')));
  });

  // [LAW:verifiable-goals] THE SECOND ACCEPTANCE CRITERION — a pass whose spawns straddle 04:00 UTC
  // bills each spawn at its own tier. Driven through the adapter's extractUsage, the layer that turns
  // an instant into a priced spawn, and then through the real sumCost the pass total uses. The other
  // half of the seam — that makeCliAdapter gives each spawn its OWN instant, and the same one it
  // records as span.from — is not asserted here: it is driven against a live spawn in
  // test/engine-cli.test.js, because nothing at this layer could tell one clock read from two.
  test('a pass straddling 04:00 UTC bills each spawn at its own tier, and the sum is not repriced', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    const before = claudeExtractUsage(stdout, DEEPSEEK_CONFIG, new Date('2026-08-20T03:50:00.000Z')); // peak
    const after = claudeExtractUsage(stdout, DEEPSEEK_CONFIG, new Date('2026-08-20T04:10:00.000Z'));  // off-peak

    assert.ok(Math.abs(before.cost.usd - 5.28) < 1e-9, `peak spawn: ${before.cost.usd}`);
    assert.ok(Math.abs(after.cost.usd - 2.64) < 1e-9, `off-peak spawn: ${after.cost.usd}`);

    const total = sumCost([before.cost, after.cost]);
    assert.equal(total.basis, 'dollars');
    // 7.92 — the sum of two individually-priced spawns. Neither 5.28x2 (the whole pass at the tier it
    // started in, the shape this ticket forbids) nor 2.64x2 (priced at the tier it ended in).
    assert.ok(Math.abs(total.usd - 7.92) < 1e-9, `pass total: ${total.usd}`);
  });

  test('pricing needs the instant as a value: a missing or invalid one throws, never prices at standard', () => {
    // The failure this replaces is silent: NaN coordinates match no window, so a caller that forgot
    // to thread the instant would have billed every peak review at half rate with nothing to notice.
    //
    // Each case varies ONLY `at`, on a spawn that is otherwise well-formed. The predecessor passed
    // TOKENS — a bare token record — in the SPAWN position and put the instant in a third argument
    // the 2-arity function never receives, so all three cases collapsed into one: every call threw on
    // the same missing `.at`, and neither the Invalid Date nor the string was ever reached. A test
    // that passes for a reason other than the one it names asserts nothing. [LAW:behavior-not-structure]
    const wellFormed = spawnFromTokens(new Date('2026-08-20T02:30:00Z'), TOKENS);
    const withInstant = (at) => ({ ...wellFormed, at });

    assert.throws(() => priceFromTable({ tokens: TOKENS, context: wellFormed.context }, 'deepseek-v4-pro'), /start instant/);
    assert.throws(() => priceFromTable(withInstant(new Date('nonsense')), 'deepseek-v4-pro'), /start instant/);
    assert.throws(() => priceFromTable(withInstant('2026-08-20T02:30:00Z'), 'deepseek-v4-pro'), /start instant/);

    // The control: the same spawn WITH a real instant prices, so the three throws above are
    // attributable to `at` alone and not to anything else about the fixture.
    assert.equal(priceFromTable(wellFormed, 'deepseek-v4-pro').basis, 'dollars');
  });

  test('pricing needs the context interval too: a spawn missing it throws for every model, not just context-tiered ones', () => {
    // The regression this guards: `context` used to pass through spawnFacts unparsed, so a hand-rolled
    // `{at, tokens}` priced CLEANLY against every flat or time-tiered model and only detonated against
    // a context-tiered one. The same threading bug was invisible in most of the table and fatal in one
    // corner of it — so both a time-tiered and a context-tiered model are asserted here.
    const at = new Date('2026-08-20T02:30:00Z');
    assert.throws(() => priceFromTable({ at, tokens: TOKENS }, 'deepseek-v4-pro'), /context/);
    assert.throws(() => priceFromTable({ at, tokens: TOKENS }, 'gpt-5.6-sol'), /context/);
  });
});

// --- the price table is selected by a VECTOR of facts (zai-cost-truth-p5o.4) ---

describe('context-length rates', () => {
  // [LAW:verifiable-goals] THE ACCEPTANCE CRITERION. One identical usage record priced at a short and
  // a long context, asserting the multiple OpenAI publishes. The context is stated as an EXACT
  // interval, which is the only way either card can be proven to apply — see the sibling test on what
  // a real spawn can prove. The multiple is asserted rather than encoded as a multiplier in the table,
  // so this still fails the day OpenAI prices its two cards independently.
  const tokensOf = n => ({ inputCacheMiss: n, inputCacheHit: 0, output: 0 });
  // A spawn whose context is EXACTLY known — the shape an adapter that can observe a per-request
  // context would build. codex cannot (see the sibling test), so this is the schedule's contract
  // rather than a claim about today's engines.
  const atContext = (n, tokens) => ({ at: OFF_PEAK, tokens, context: { min: n, max: n } });
  const usdAtContext = (n, tokens, model) => {
    const cost = priceFromTable(atContext(n, tokens), model);
    assert.equal(cost.basis, 'dollars', `expected a priced result, got ${JSON.stringify(cost)}`);
    return cost.usd;
  };

  test('the same tokens cost the published multiple at a long context as at a short one', () => {
    // ONE identical usage record, priced twice, differing only in the context it was spent at.
    // gpt-5.6-sol: input 4.00 short, 8.00 long — 100k tokens is 0.40 or 0.80.
    const tokens = tokensOf(100_000);
    const short = usdAtContext(100_000, tokens, 'gpt-5.6-sol');
    const long = usdAtContext(300_000, tokens, 'gpt-5.6-sol');
    assert.ok(Math.abs(short - 0.40) < 1e-9, `short: ${short}`);
    assert.ok(Math.abs(long - 0.80) < 1e-9, `long: ${long}`);
    // The multiple OpenAI publishes, asserted rather than encoded as a multiplier in the table — so
    // this fails the day it prices its two cards independently.
    assert.ok(Math.abs(long - short * 2) < 1e-12);
  });

  test('the boundary belongs to the short card: 272,000 is short, 272,001 is long', () => {
    // "≤272K input tokens" / ">272K input tokens", the vendor's own tooltips. Half-open, exactly as
    // the hour windows are, so neither card can claim the boundary token nor leave it unclaimed.
    const tokens = tokensOf(1_000_000);
    assert.ok(Math.abs(usdAtContext(272_000, tokens, 'gpt-5.6-luna') - 0.20) < 1e-12);
    assert.ok(Math.abs(usdAtContext(272_001, tokens, 'gpt-5.6-luna') - 0.40) < 1e-12);
  });

  test('a flat-rate model prices identically at every context size, as it does at every instant', () => {
    // The third acceptance criterion: adding an axis must not make a flat vendor a special case.
    const tokens = tokensOf(1_000_000);
    assert.equal(usdAtContext(1_000, tokens, 'glm-5.1'), usdAtContext(9_000_000, tokens, 'glm-5.1'));
    // …and it still prices from what a real spawn can prove, where the context is only bounded.
    assert.equal(usd(tokens, 'glm-5.1', OFF_PEAK), usdAtContext(1_000, tokens, 'glm-5.1'));
  });

  test('a spawn too large to prove its per-request context is unpriced, never priced at either card', () => {
    // What a REAL codex spawn reports is a SUM over the turn's requests, so a 900k total proves only
    // that no single request exceeded 900k — it could be one long request or twenty short ones, which
    // bill at different cards. Pricing it at the long card would double a short-context spawn's bill;
    // pricing it at the short card would halve a long one's. The honest answer is neither.
    assert.equal(unpriced(tokensOf(900_000), 'gpt-5.6-sol', OFF_PEAK), 'schedule-gap');
    // Under the threshold the bound is proof enough, so the common spawn still prices.
    assert.ok(usd(tokensOf(100_000), 'gpt-5.6-sol', OFF_PEAK) > 0);
  });

  test('a vendor that publishes no card above its threshold declines rather than extending the last one', () => {
    // OpenAI lists "gpt-5.5 (<272K context length)" and prices nothing above it, while the model's own
    // context window is 1,050,000 — so the gap is reachable. The previous shape could not express this
    // at all: a standard rate applied everywhere, asserting the ≤272K price at 900k.
    const tokens = tokensOf(1_000);
    for (const model of ['gpt-5.5', 'gpt-5.4']) {
      const cost = priceFromTable(atContext(300_000, tokens), model);
      assert.equal(cost.basis, 'unpriced', `${model} must decline above 272K`);
      assert.equal(cost.reason, 'schedule-gap');
    }
  });

  test('an unknown constraint axis throws rather than reading as satisfied', () => {
    // A constraint nobody can evaluate must not silently hold: that would price the spawn off
    // whichever card happened to be listed first.
    const entry = { tiers: [{ when: [{ axis: 'serviceTier', is: 'flex' }], rates: { input: 1, cachedInput: 1, output: 1 } }] };
    assert.throws(() => ratesAt(entry, { day: 6, hour: 2, context: { min: 0, max: 10 } }), /unknown axis/);
  });
});

// --- codexExtractUsage (real codex exec --json shape) ---

describe('codexExtractUsage', () => {
  test('reads usage from the final turn.completed and computes USD from the price table', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"reasoning_output_tokens":200}}',
    ].join('\n');
    const usage = codexExtractUsage(stdout, CODEX_CONFIG, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 5000);
    assert.equal(usage.tokens.output, 500);
    assert.equal(usage.cost.basis, 'dollars');
    // (4000*0.75 + 1000*0.075 + 500*4.50)/1e6 = (3000 + 75 + 2250)/1e6 = 0.005325
    assert.ok(Math.abs(usage.cost.usd - 0.005325) < 1e-9, `got ${usage.cost.usd}`);
  });

  test('the last turn.completed wins when several are emitted', () => {
    const stdout = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":9000,"output_tokens":300}}',
    ].join('\n');
    const usage = codexExtractUsage(stdout, CODEX_CONFIG, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 9000);
    assert.equal(usage.tokens.output, 300);
  });

  test('cost is unavailable with reason no-price (tokens still reported) when the model has no price', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}';
    const usage = codexExtractUsage(stdout, { ...CODEX_CONFIG, model: 'gpt-future' }, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 100);
    assert.deepEqual(usage.cost, { basis: 'unpriced', reason: 'no-price' });
  });

  test('returns null when no turn.completed carries usage', () => {
    const stdout = '{"type":"thread.started","thread_id":"abc"}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG, OFF_PEAK), null);
  });

  test('an empty usage object is reported as no usage, not a $0.00 run', () => {
    const stdout = '{"type":"turn.completed","usage":{}}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG, OFF_PEAK), null);
  });
});

// --- claudeExtractUsage (real -p --output-format json envelope) ---

describe('claudeExtractUsage', () => {
  test('reads provider-reported total_cost_usd and sums all input-side token fields', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 250,
      },
    });
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 1000 + 4000 + 250);
    assert.equal(usage.tokens.output, 500);
    assert.deepEqual(usage.cost, { basis: 'dollars', usd: 0.0123 });
  });

  test('cost is unavailable with reason not-reported when a genuine Anthropic envelope omits total_cost_usd', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 10);
    assert.deepEqual(usage.cost, { basis: 'unpriced', reason: 'not-reported' });
  });

  test('a non-Anthropic endpoint is priced from its own table entry — Anthropic total_cost_usd is ignored', () => {
    // [LAW:no-silent-failure] claude-code prices total_cost_usd against Anthropic; for deepseek that
    // is the wrong vendor, so it is discarded and cost is computed from deepseek's own price entry.
    // Anthropic-style buckets: fresh + cache_creation at full rate, cache_read at the cached rate.
    const stdout = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.5, // wrong-vendor figure — must NOT appear in the result
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const usage = claudeExtractUsage(stdout, DEEPSEEK_CONFIG, OFF_PEAK);
    assert.equal(totalInputTokens(usage.tokens), 1_000_000);
    assert.equal(usage.cost.basis, 'dollars');
    // deepseek-v4-pro off-peak: 1M in @0.66 + 1M out @1.98 = 2.64 — not the 0.5 Anthropic figure.
    assert.ok(Math.abs(usage.cost.usd - 2.64) < 1e-9, `got ${usage.cost.usd}`);
  });

  test('cache reads bill at the discounted cached rate, fresh + cache writes at the full rate', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1_000_000, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 250_000, output_tokens: 100_000 },
    });
    const usage = claudeExtractUsage(stdout, DEEPSEEK_CONFIG, OFF_PEAK);
    // full-rate = fresh(1M) + cache_creation(250k) = 1.25M @0.66; cached = cache_read(500k) @0.022; out 100k @1.98.
    const expected = (1_250_000 * 0.66 + 500_000 * 0.022 + 100_000 * 1.98) / 1e6;
    assert.ok(Math.abs(usage.cost.usd - expected) < 1e-9, `got ${usage.cost.usd}, expected ${expected}`);
  });

  test('a foreign endpoint whose model is not in the table reports no-price (tokens still shown)', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const unlisted = { engine: 'claude-code', model: 'glm-unreleased', endpoint: { baseUrl: 'https://api.z.ai/api/anthropic', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, unlisted, OFF_PEAK).cost, { basis: 'unpriced', reason: 'no-price' });
  });

  test('a lookalike host (notanthropic.com) is classified foreign, not trusted as Anthropic', () => {
    // [LAW:types-are-the-program] regression: endsWith('anthropic.com') wrongly accepted this host.
    // model not in the table → no-price (proves total_cost_usd was NOT used); genuine host → total_cost_usd.
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const lookalike = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.notanthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, lookalike, OFF_PEAK).cost, { basis: 'unpriced', reason: 'no-price' });
    const sub = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, sub, OFF_PEAK).cost, { basis: 'dollars', usd: 0.5 });
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2: a subscription run's figure is Anthropic LIST
  // PRICE for tokens billed to plan quota. It is EMITTED — the figure is the deliverable, it answers
  // "is the subscription cheaper than the API bill?" — under a distinctly-named field on a distinct
  // variant, so no spend fold has a `usd` here to pick up.
  test('a subscription run reports its list price as NOTIONAL, never as spend', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 } });
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG, OFF_PEAK).cost, { basis: 'subscription', notionalUsd: 0.42 });
    // the structural exclusion: there is no `usd` field for a spend fold to read, at all.
    assert.equal('usd' in claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG, OFF_PEAK).cost, false);
  });

  // [LAW:no-silent-failure] AC for zai-billing-xl0.2: an omitted total_cost_usd under a subscription
  // is an unavailable NOTIONAL, never 0.00 — "we don't know the list price" and "the list price was
  // zero" are different facts and must not collapse. The basis stays subscription either way: what
  // the run cost in DOLLARS is known exactly (nothing); only its list price is missing.
  test('a subscription run with no total_cost_usd reports the notional as unavailable, not as zero', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG, OFF_PEAK).cost, { basis: 'subscription', notionalUsd: null });
  });

  // A garbage total_cost_usd must not become a NaN notional that later renders "$NaN".
  test('a non-finite total_cost_usd under a subscription is an unavailable notional', () => {
    const stdout = '{"type":"result","total_cost_usd":"lots","usage":{"input_tokens":10,"output_tokens":5}}';
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG, OFF_PEAK).cost, { basis: 'subscription', notionalUsd: null });
  });

  test('returns null when the envelope has no usage', () => {
    assert.equal(claudeExtractUsage('{"type":"result","result":"x"}', ANTHROPIC_CONFIG, OFF_PEAK), null);
  });

  test('returns null when stdout is not a parseable envelope', () => {
    assert.equal(claudeExtractUsage('not json at all', ANTHROPIC_CONFIG, OFF_PEAK), null);
  });
});

// --- renderCostLine (pure formatting) ---

describe('renderCostLine', () => {
  test('renders dollars, comma-grouped tokens, and the engine/model tag', () => {
    const line = renderCostLine({ tokens: { inputCacheMiss: 12345, inputCacheHit: 0, output: 6789 }, cost: { basis: 'dollars', usd: 0.0123 } }, CODEX_CONFIG);
    assert.match(line, /\$0\.0123/);
    assert.match(line, /12,345 in \(0 cached\) \/ 6,789 out tokens/);
    assert.match(line, /codex\/gpt-5\.4-mini/);
  });

  test('marks every cost as an estimate — codex (list-price table) included, not just claude', () => {
    const line = renderCostLine({ tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'dollars', usd: 0.5 } }, CODEX_CONFIG);
    assert.match(line, /· est\.$|· est\._$/);
  });

  test('a non-z.ai claude-code run is still marked an estimate (total_cost_usd is client-side)', () => {
    const anthropicConfig = { engine: 'claude-code', model: 'claude-x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    const line = renderCostLine({ tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'dollars', usd: 0.5 } }, anthropicConfig);
    assert.match(line, /· est\._$/);
    assert.doesNotMatch(line, /z\.ai/);
  });

  test('a z.ai/deepseek (foreign) claude-code run renders its own table-priced cost, never the Anthropic figure', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    const dsLine = renderCostLine(claudeExtractUsage(stdout, DEEPSEEK_CONFIG, OFF_PEAK), DEEPSEEK_CONFIG);
    assert.match(dsLine, /\$2\.6400/);          // deepseek-priced, not $0.5000
    assert.doesNotMatch(dsLine, /\$0\.5000/);
    assert.match(dsLine, /· est\._$/);
    const glmLine = renderCostLine(claudeExtractUsage(stdout, ZAI_CONFIG, OFF_PEAK), ZAI_CONFIG);
    assert.match(glmLine, /Cost: \$/);          // glm-5.1 priced
    assert.doesNotMatch(glmLine, /unknown/);
  });

  test('shows cost as "unknown" (tokens still rendered) when cost is unavailable', () => {
    const line = renderCostLine({ tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'unpriced', reason: 'no-price' } }, CODEX_CONFIG);
    assert.match(line, /Cost: unknown/);
    assert.match(line, /100 in \(0 cached\) \/ 50 out tokens/);
  });

  test('returns empty string when there is no usage at all', () => {
    assert.equal(renderCostLine(null, CODEX_CONFIG), '');
  });

  // A spawn whose engine reported nothing still carries its host-stamped span (zai-timing-31d.4);
  // the rendered output is the same empty line the null-usage shape always produced.
  test('returns empty string for a span-only usage — the engine reported no tokens to render', () => {
    assert.equal(renderCostLine({ span: { from: '2026-08-22T03:30:00.000Z', to: '2026-08-22T03:35:00.000Z' } }, CODEX_CONFIG), '');
  });

  test('no prior rounds → single-round line, no PR total (first review unchanged)', () => {
    const usage = { tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'dollars', usd: 0.02 } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior());
    assert.doesNotMatch(line, /PR total/);
    assert.match(line, /· est\._$/);
  });

  test('with prior rounds → appends a running PR total across all rounds', () => {
    const usage = { tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'dollars', usd: 0.03 } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior({ usd: 0.09, count: 2 }));
    assert.match(line, /\$0\.0300/);                          // this round
    assert.match(line, /PR total \$0\.1200 across 3 rounds/); // 0.09 prior + 0.03 this
  });

  test('an unknown-cost round makes the PR total a lower bound (+) and names the unpriced count', () => {
    const usage = { tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'unpriced', reason: 'no-price' } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior({ usd: 0.09, count: 2, unknownCount: 1 }));
    assert.match(line, /PR total \$0\.0900\+ across 4 rounds, 2 with unknown cost/);
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2: the notional figure IS present in the footer —
  // it is the deliverable, not the hazard — but it is labelled as list price and the line leads with
  // the truth that nothing was billed.
  test('a subscription run renders its list price, labelled as not billed', () => {
    const usage = { tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'subscription', notionalUsd: 63.59 } };
    const line = renderCostLine(usage, SUBSCRIPTION_CONFIG);
    assert.match(line, /Not billed \(Claude subscription\)/);
    assert.match(line, /\$63\.5900 at Anthropic list price/);
    assert.match(line, /100 in \(0 cached\) \/ 50 out tokens/);
    assert.match(line, /· est\._$/);
  });

  test('a subscription run with no list price says so — never "$0.0000"', () => {
    const usage = { tokens: { inputCacheMiss: 100, inputCacheHit: 0, output: 50 }, cost: { basis: 'subscription', notionalUsd: null } };
    const line = renderCostLine(usage, SUBSCRIPTION_CONFIG);
    assert.match(line, /Not billed \(Claude subscription\)/);
    assert.match(line, /list price not reported/);
    assert.doesNotMatch(line, /\$0\.0000/);
  });
});

// The measured token split of a real review (PR #108, deepseek-v4-pro, 2026-08-22, a Saturday and so
// off-peak under the Monday-Friday schedule whatever the hour) —
// the run whose collapsed footer forced an audit to BORROW a cache-hit ratio from an unrelated local
// run. Using the real numbers keeps the round-trip test honest about magnitude: 91.8% of this input
// is cache-hit, priced ~30x below the miss class, so a marker that fused them could not reprice.
const SAMPLE_TOKENS = { inputCacheMiss: 2_212_240, inputCacheHit: 24_807_936, output: 609_161 };
const SAMPLE_SPAN = { from: '2026-08-22T03:30:00.000Z', to: '2026-08-22T04:01:00.000Z' };
const usageOf = cost => ({ tokens: SAMPLE_TOKENS, span: SAMPLE_SPAN, cost });

describe('cost marker (machine-readable per-round cost)', () => {
  test('round-trips an available cost', () => {
    assert.equal(parseCostMarker(costMarker(usageOf({ basis: 'dollars', usd: 0.1234 }), DEEPSEEK_CONFIG)), 0.1234);
  });
  test('records unavailable cost as the string "unknown"', () => {
    assert.equal(parseCostMarker(costMarker(usageOf({ basis: 'unpriced', reason: 'no-price' }), DEEPSEEK_CONFIG)), 'unknown');
    assert.equal(parseCostMarker(costMarker(null, DEEPSEEK_CONFIG)), 'unknown');
  });
  test('a body with no marker (human review / old review) parses to null', () => {
    assert.equal(parseCostMarker('just a comment, no marker'), null);
    assert.equal(parseCostMarker(null), null);
  });
  test('a malformed marker value never returns NaN (would poison the PR total) — parses to null', () => {
    for (const bad of ['.', '1.2.3', '123..456', '', 'abc']) {
      const r = parseCostMarker(`<!-- agent-review-cost-usd:${bad} -->`);
      assert.ok(r === null, `"${bad}" must parse to null, got ${r}`);
    }
  });
  test('the marker is an invisible HTML comment (does not render in the review body)', () => {
    assert.match(costMarker(usageOf({ basis: 'dollars', usd: 1 }), DEEPSEEK_CONFIG), /^<!-- .* -->$/);
  });
  test('takes the LAST marker — a body quoting a marker in prose + the real one at the end', () => {
    // A review OF this feature could quote a marker in its summary; the real cost marker trails it.
    const body = `Findings: the format is ${costMarker(usageOf({ basis: 'dollars', usd: 9.99 }), DEEPSEEK_CONFIG)} for example.\n\n`
      + `footer\n\n${costMarker(usageOf({ basis: 'dollars', usd: 0.42 }), DEEPSEEK_CONFIG)}\n\n<!-- copirate-code-review-agent -->`;
    assert.equal(parseCostMarker(body), 0.42); // the real trailing marker, not the quoted 9.99
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2, the STRUCTURAL half. Every spend fold in this
  // codebase reads markers through parseCostMarker; a subscription review writes a differently-named
  // marker carrying a differently-named figure field, so the spend readers have nothing to match.
  // This is the property that makes the exclusion impossible to forget rather than merely documented.
  test('a subscription cost writes a NOTIONAL marker that no spend reader can see', () => {
    const marker = costMarker(usageOf({ basis: 'subscription', notionalUsd: 63.59 }), SUBSCRIPTION_CONFIG);
    assert.match(marker, /^<!-- agent-review-notional-usd:\{/);
    assert.ok(!marker.includes('"usd"'), 'notional dollars must never be written under the spend field name');
    assert.equal(parseCostMarker(marker), null); // invisible to every spend fold, by construction
    assert.deepEqual(parseCost(marker), { basis: 'subscription', notionalUsd: 63.59 });
  });

  test('a subscription cost with no list price still writes a notional marker, valued unknown', () => {
    const marker = costMarker(usageOf({ basis: 'subscription', notionalUsd: null }), SUBSCRIPTION_CONFIG);
    assert.match(marker, /^<!-- agent-review-notional-usd:\{/);
    assert.equal(parseCostMarker(marker), null);
    assert.deepEqual(parseCost(marker), { basis: 'subscription', notionalUsd: null });
  });

  test('parseCost round-trips every basis back to the value that wrote it', () => {
    const mk = cost => costMarker(usageOf(cost), DEEPSEEK_CONFIG);
    assert.deepEqual(parseCost(mk({ basis: 'dollars', usd: 0.1234 })), { basis: 'dollars', usd: 0.1234 });
    assert.deepEqual(parseCost(mk({ basis: 'subscription', notionalUsd: 63.59 })), { basis: 'subscription', notionalUsd: 63.59 });
    assert.deepEqual(parseCost(mk({ basis: 'subscription', notionalUsd: null })), { basis: 'subscription', notionalUsd: null });
    assert.deepEqual(parseCost(mk({ basis: 'unpriced', reason: 'no-price' })), { basis: 'unpriced', reason: 'not-reported' });
    assert.equal(parseCost('a human review with no marker'), null);
  });

  // The last-match rule has to hold ACROSS the two marker names, not just within each. Deciding the
  // basis by "is there a notional marker anywhere?" before looking at the spend marker read a real
  // DOLLARS round as subscription — and a subscription-basis cost has no `usd` for any spend fold to
  // find, so that round's actual spend left the daily ledger and the PR total silently. A review OF
  // this feature quotes both marker names in its prose, so this is the ordinary case, not a stunt.
  test('a dollars review that QUOTES a notional marker in its prose is still dollars', () => {
    const body = [
      'The subscription arm writes <!-- agent-review-notional-usd:63.590000 --> instead.',
      costMarker(usageOf({ basis: 'dollars', usd: 0.4200 }), DEEPSEEK_CONFIG),
    ].join('\n');
    assert.deepEqual(parseCost(body), { basis: 'dollars', usd: 0.42 });
  });

  test('a subscription review that QUOTES a spend marker in its prose is still subscription', () => {
    const body = [
      'A paid round writes <!-- agent-review-cost-usd:0.420000 --> instead.',
      costMarker(usageOf({ basis: 'subscription', notionalUsd: 63.59 }), SUBSCRIPTION_CONFIG),
    ].join('\n');
    assert.deepEqual(parseCost(body), { basis: 'subscription', notionalUsd: 63.59 });
  });
});

describe('cost marker — the recorded facts re-derive the cost (zai-cost-truth-p5o.2)', () => {
  // [LAW:verifiable-goals] THE ACCEPTANCE CRITERION. The recorded facts ALONE must re-derive the
  // cost — no assumed cache-hit ratio, no borrowed measurement from some other run. This is what a
  // corrected price table needs in order to restate a review that has already been posted, and it is
  // exactly what the collapsed "16,389,982 in" figure could not supply.
  test('a recorded marker reprices to the exact same USD through priceFromTable', () => {
    const priced = usd(SAMPLE_TOKENS, DEEPSEEK_CONFIG.model, new Date(SAMPLE_SPAN.from));
    const marker = costMarker({ tokens: SAMPLE_TOKENS, span: SAMPLE_SPAN, cost: { basis: 'dollars', usd: priced } }, DEEPSEEK_CONFIG);

    const record = parseCostRecord(marker);
    assert.deepEqual(record.tokens, SAMPLE_TOKENS);
    assert.equal(record.model, 'deepseek-v4-pro');
    // Repriced from the record ALONE — its own tokens, its own model, and its own recorded start
    // instant. Now that the table is a schedule, the span is not decoration on the record: it is the
    // third input the price needs, and a restatement that guessed at it would be guessing at the rate.
    assert.equal(usd(record.tokens, record.model, new Date(record.from)), priced);
  });

  test('the record carries the provider identity, the model, and the pass time span', () => {
    const record = parseCostRecord(costMarker(usageOf({ basis: 'dollars', usd: 1.5 }), DEEPSEEK_CONFIG));
    assert.equal(record.provider, 'api.deepseek.com');
    assert.equal(record.model, 'deepseek-v4-pro');
    assert.equal(record.from, SAMPLE_SPAN.from);
    assert.equal(record.to, SAMPLE_SPAN.to);
  });

  // The provider identity must be stable across how a config was LABELLED — `PROVIDER: auto` and
  // `PROVIDER: deepseek` are the same money — and must separate genuinely different vendors.
  test('provider identity follows the endpoint, not the config name', () => {
    const relabelled = { ...DEEPSEEK_CONFIG, name: 'auto' };
    assert.equal(providerIdentity(relabelled), providerIdentity(DEEPSEEK_CONFIG));
    assert.notEqual(providerIdentity(ZAI_CONFIG), providerIdentity(DEEPSEEK_CONFIG));
  });

  // [LAW:no-silent-failure] Every review posted before this feature carries a bare-figure marker, and
  // those reviews are permanent — a PR reads its own history back to build its running total. A
  // legacy marker must therefore tally exactly as it always did: not a throw, and not a silent zero.
  test('a legacy USD-only marker still parses and sums into the PR total', () => {
    const legacy = '<!-- agent-review-cost-usd:0.651731 -->';
    assert.deepEqual(parseCost(legacy), { basis: 'dollars', usd: 0.651731 });
    const summed = sumCost([parseCost(legacy), { basis: 'dollars', usd: 0.1 }]);
    assert.equal(summed.basis, 'dollars');
    assert.ok(Math.abs(summed.usd - 0.751731) < 1e-9, `legacy round must sum, got ${summed.usd}`);

    // …and it honestly reports that it recorded none of the facts a repricing would need.
    const record = parseCostRecord(legacy);
    assert.equal(record.tokens, null);
    assert.equal(record.model, null);
    assert.equal(record.provider, null);
    assert.equal(record.from, null);
  });

  test('a legacy unknown marker is still an unknown-cost round, never a free one', () => {
    assert.deepEqual(parseCost('<!-- agent-review-cost-usd:unknown -->'), { basis: 'unpriced', reason: 'not-reported' });
    assert.deepEqual(parseCost('<!-- agent-review-notional-usd:unknown -->'), { basis: 'subscription', notionalUsd: null });
  });

  // [LAW:types-are-the-program] The payload cannot terminate its own HTML comment: the grammar admits
  // no '>' , and the encoder escapes every one into the JSON unicode form. A model id chosen to spell
  // '-->' is the adversarial case, and it round-trips byte-for-byte instead of truncating the marker.
  test('a model id containing "-->" cannot break out of the comment', () => {
    const hostile = { ...DEEPSEEK_CONFIG, model: 'evil--> <!-- agent-review-cost-usd:99.0 -->' };
    const marker = costMarker(usageOf({ basis: 'dollars', usd: 0.25 }), hostile);
    assert.equal(marker.match(/-->/g).length, 1, 'exactly one comment terminator: the marker\'s own');
    const record = parseCostRecord(marker);
    assert.equal(record.model, hostile.model);
    assert.deepEqual(record.cost, { basis: 'dollars', usd: 0.25 });
  });

  // [LAW:parse-dont-validate] The legacy grammar forbade a negative figure STRUCTURALLY — its value
  // pattern admits no leading '-'. The record payload is JSON and could spell one, so the widening
  // must not lose the guarantee: a hand-edited negative would SUBTRACT from the PR total and the
  // daily ledger, and under-counted spend is what RELEASES a budget gate rather than tripping it.
  test('a negative figure is unrecordable, never a credit against the PR total', () => {
    const negative = '<!-- agent-review-cost-usd:{"usd":-999999} -->';
    assert.deepEqual(parseCost(negative), { basis: 'unpriced', reason: 'not-reported' });
    assert.equal(parseCostMarker(negative), 'unknown');
    // and it cannot come back as a negative list price either
    assert.deepEqual(parseCost('<!-- agent-review-notional-usd:{"notionalUsd":-5} -->'), { basis: 'subscription', notionalUsd: null });
  });

  // [LAW:single-enforcer] The writer screens through the same predicate the reader does, so the set
  // of figures costMarker can emit IS the set parseCostRecord accepts. Applied on one side only, a
  // marker would round-trip to a different value than it was written from.
  test('the writer cannot emit a figure the reader would refuse — on either basis', () => {
    for (const bad of [-1, -0.000001, NaN, Infinity, -Infinity]) {
      const dollars = costMarker(usageOf({ basis: 'dollars', usd: bad }), DEEPSEEK_CONFIG);
      assert.ok(!dollars.includes('"usd"'), `${bad} must not be written as a figure: ${dollars}`);
      assert.deepEqual(parseCost(dollars), { basis: 'unpriced', reason: 'not-reported' });

      // The notional arm carries the SAME guarantee. Screening one basis and not the other would be
      // the asymmetry this test exists to forbid, one arm over.
      const notional = costMarker(usageOf({ basis: 'subscription', notionalUsd: bad }), SUBSCRIPTION_CONFIG);
      assert.ok(!notional.includes('"notionalUsd"'), `${bad} must not be written as a list price: ${notional}`);
      assert.deepEqual(parseCost(notional), { basis: 'subscription', notionalUsd: null });
    }
  });

  // The claim is about the WHOLE record, not just the figure: every field the writer emits must be
  // one the reader accepts. Screening the figure alone still let a negative token count go out to be
  // refused on the way back in — a marker that round-trips to something other than what it recorded.
  test('the writer cannot emit a token record the reader would refuse', () => {
    const negative = { tokens: { inputCacheMiss: -5, inputCacheHit: 10, output: 2 }, cost: { basis: 'dollars', usd: 1 } };
    const marker = costMarker(negative, DEEPSEEK_CONFIG);
    assert.ok(!marker.includes('tokens'), `an unrecordable token record must not be written: ${marker}`);
    assert.equal(parseCostRecord(marker).tokens, null);
  });

  // A config naming no model is reachable in config-file mode; the writer must not emit a field the
  // reader would score as absent anyway.
  test('a config naming no model records no model, not an empty one', () => {
    const marker = costMarker(usageOf({ basis: 'dollars', usd: 1 }), { ...DEEPSEEK_CONFIG, model: '' });
    assert.ok(!marker.includes('"model"'), `an empty model must not be written: ${marker}`);
    assert.equal(parseCostRecord(marker).model, null);
  });

  test('a negative token count makes the whole record unrepriceable, never a negative charge', () => {
    const body = '<!-- agent-review-cost-usd:{"usd":1,"tokens":{"inputCacheMiss":-5,"inputCacheHit":10,"output":2}} -->';
    assert.equal(parseCostRecord(body).tokens, null);
  });

  // A comment terminator needs a '>', which is escaped, so a bare '--' can never end the comment for
  // OUR reader. It is escaped anyway because "the marker is invisible" is a claim about somebody
  // else's markdown renderer, and CommonMark <=0.29 forbade '--' inside a comment outright.
  test('no bare "--" survives into the payload', () => {
    const hostile = { ...DEEPSEEK_CONFIG, model: 'a--b----c' };
    const marker = costMarker(usageOf({ basis: 'dollars', usd: 0.25 }), hostile);
    const payload = marker.slice(marker.indexOf(':{') + 1, marker.lastIndexOf(' -->'));
    assert.ok(!payload.includes('--'), `payload must carry no bare "--": ${payload}`);
    assert.equal(parseCostRecord(marker).model, 'a--b----c'); // …and it still round-trips exactly
  });

  // A record whose token classes are incomplete cannot reprice anything, and pricing two of three
  // classes as if they were all of them would understate the run — the same lie in a smaller font.
  test('a partial token record reads as no token record at all', () => {
    const partial = '<!-- agent-review-cost-usd:{"usd":0.5,"tokens":{"inputCacheMiss":10}} -->';
    const record = parseCostRecord(partial);
    assert.equal(record.tokens, null);
    assert.deepEqual(record.cost, { basis: 'dollars', usd: 0.5 });
  });

  // The one marker shape zai-timing-31d.4 introduced: a spawn whose engine reported nothing still
  // records its host-stamped span. The persistence path must keep the window while honestly
  // recording the absent figure — an unknown-cost round that still says WHEN it ran.
  test('a span-only usage round-trips: from/to recorded, tokens null, cost unpriced', () => {
    const span = { from: '2026-08-22T03:30:00.000Z', to: '2026-08-22T03:35:00.000Z' };
    const marker = costMarker({ span }, DEEPSEEK_CONFIG);
    const record = parseCostRecord(marker);
    assert.equal(record.from, span.from);
    assert.equal(record.to, span.to);
    assert.equal(record.tokens, null);
    assert.deepEqual(record.cost, { basis: 'unpriced', reason: 'not-reported' });
  });
});

// zai-timing-31d.2 — the round's wall clock is recorded beside its cost, in the SAME marker, so a
// later run can sum a PR's agent time from bodies it did not write. The review bodies are the only
// store that survives across runs; a duration that renders for humans and is then thrown away leaves
// the cumulative total (zai-timing-31d.3) with nothing to add up.
describe('duration record (zai-timing-31d.2)', () => {
  // [LAW:verifiable-goals] THE ACCEPTANCE CRITERION: a known duration in, the same duration out.
  test('a recorded duration round-trips through the marker exactly', () => {
    const totalMs = 17 * 60_000 + 1_000; // the 17m01s run the epic was opened over
    const record = parseCostRecord(costMarker(usageOf({ basis: 'dollars', usd: 1.5 }), DEEPSEEK_CONFIG, totalMs));
    assert.equal(record.totalMs, totalMs);
    // …and it rides the EXISTING marker rather than a second one of its own.
    assert.equal(costMarker(usageOf({ basis: 'dollars', usd: 1.5 }), DEEPSEEK_CONFIG, totalMs).match(/<!--/g).length, 1);
  });

  // The duration must not disturb the facts already recorded: this marker is read by the daily
  // ledger and the PR spend total, and a round whose cost stopped parsing because it learned to
  // report its time would trade the product for the diagnostics. [LAW:no-silent-failure]
  test('recording a duration leaves the cost, tokens, model and span untouched', () => {
    const record = parseCostRecord(costMarker(usageOf({ basis: 'dollars', usd: 1.5 }), DEEPSEEK_CONFIG, 5_000));
    assert.deepEqual(record.cost, { basis: 'dollars', usd: 1.5 });
    assert.deepEqual(record.tokens, SAMPLE_TOKENS);
    assert.equal(record.model, 'deepseek-v4-pro');
    assert.equal(record.from, SAMPLE_SPAN.from);
  });

  // A subscription round is timed like any other — agent time is spent whether or not it is billed.
  test('a subscription round records its duration too', () => {
    const marker = costMarker(usageOf({ basis: 'subscription', notionalUsd: 63.59 }), SUBSCRIPTION_CONFIG, 90_000);
    assert.equal(parseCostRecord(marker).totalMs, 90_000);
  });

  // [LAW:no-silent-failure] The three shapes of "no duration recorded" — a sink with no round to
  // time (the ledger), a review posted before this feature, and a body carrying no marker at all.
  // Each reads as an explicit absence. A zero would assert the round was instantaneous, and a throw
  // would let one old body break a total summed across every round of a PR.
  test('a round that recorded no duration reads as an absence, never a zero and never a throw', () => {
    assert.equal(parseCostRecord(costMarker(usageOf({ basis: 'dollars', usd: 1 }), DEEPSEEK_CONFIG, null)).totalMs, null);
    assert.equal(parseCostRecord('<!-- agent-review-cost-usd:0.651731 -->').totalMs, null);
    assert.equal(parseCostRecord('a review body with no marker in it at all'), null);
  });

  // [LAW:single-enforcer] The writer screens through the same predicate as the reader, so the set of
  // durations costMarker can emit IS the set parseCostRecord accepts — the discipline the figure and
  // the token counts already hold, extended to the one field this ticket adds. A duration written to
  // be refused on the way back in is a marker that round-trips to something it never recorded.
  test('the writer cannot emit a duration the reader would refuse', () => {
    for (const bad of [-1, -60_000, NaN, Infinity, -Infinity, '5000', undefined]) {
      const marker = costMarker(usageOf({ basis: 'dollars', usd: 1 }), DEEPSEEK_CONFIG, bad);
      assert.ok(!marker.includes('totalMs'), `${String(bad)} must not be written as a duration: ${marker}`);
      assert.equal(parseCostRecord(marker).totalMs, null);
    }
    // A hand-edited negative cannot drive a PR's cumulative time DOWN either.
    assert.equal(parseCostRecord('<!-- agent-review-cost-usd:{"usd":1,"totalMs":-999999} -->').totalMs, null);
  });

  // A run finishing inside the clock's resolution is a real 0, distinct from "not recorded" — the
  // one figure this field must NOT collapse into its absence.
  test('a recorded zero is a duration, not an absence', () => {
    assert.equal(parseCostRecord(costMarker(usageOf({ basis: 'dollars', usd: 1 }), DEEPSEEK_CONFIG, 0)).totalMs, 0);
  });
});

describe('sumCost', () => {
  test('adds dollars to dollars', () => {
    assert.deepEqual(sumCost([{ basis: 'dollars', usd: 0.1 }, { basis: 'dollars', usd: 0.2 }]), { basis: 'dollars', usd: 0.1 + 0.2 });
  });

  test('adds notional to notional, under the notional name', () => {
    assert.deepEqual(
      sumCost([{ basis: 'subscription', notionalUsd: 18.86 }, { basis: 'subscription', notionalUsd: 7.28 }]),
      { basis: 'subscription', notionalUsd: 18.86 + 7.28 },
    );
  });

  // [LAW:no-silent-failure] A partial list price summed as if it were the total understates the run.
  test('one unreported notional makes the whole notional sum unreported, not a partial total', () => {
    assert.deepEqual(
      sumCost([{ basis: 'subscription', notionalUsd: 18.86 }, { basis: 'subscription', notionalUsd: null }]),
      { basis: 'subscription', notionalUsd: null },
    );
  });

  test('one unpriced spawn makes the whole sum unpriced, carrying that spawn\'s reason', () => {
    assert.deepEqual(
      sumCost([{ basis: 'dollars', usd: 0.1 }, { basis: 'unpriced', reason: 'no-price' }]),
      { basis: 'unpriced', reason: 'no-price' },
    );
  });

  test('REFUSES to add across bases — a mixed sum is unpriced, never a blended number', () => {
    const mixed = sumCost([{ basis: 'dollars', usd: 1.2 }, { basis: 'subscription', notionalUsd: 40 }]);
    assert.equal(mixed.basis, 'unpriced');
    assert.equal('usd' in mixed, false);
    assert.equal('notionalUsd' in mixed, false);
  });
});

describe('renderPrTotal', () => {
  test('empty when there is no prior-cost value at all', () => {
    assert.equal(renderPrTotal({ basis: 'dollars', usd: 1 }, null), '');
  });
  test('empty when there are zero prior rounds (the first review)', () => {
    assert.equal(renderPrTotal({ basis: 'dollars', usd: 1 }, prior()), '');
  });
  test('priced this-round + mixed known/unknown prior → total plus a "+" and the unpriced count', () => {
    const clause = renderPrTotal({ basis: 'dollars', usd: 0.03 }, prior({ usd: 0.10, count: 2, unknownCount: 1 }));
    assert.match(clause, /PR total \$0\.1300\+ across 4 rounds, 1 with unknown cost/); // 0.10 + 0.03, 1 unpriced
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2 (the evidence on the ticket: PR #113 reported a
  // $63.59 "PR total" across 4 rounds, every dollar of it notional). The two bases are reported side
  // by side and NEVER added: a blended number would be true of neither.
  test('a subscription PR totals list price under its own label, never as spend', () => {
    const clause = renderPrTotal({ basis: 'subscription', notionalUsd: 18.41 }, prior({ notionalUsd: 45.18, notionalCount: 3 }));
    assert.match(clause, /PR list-price total \$63\.5900 across 4 rounds/);
    assert.doesNotMatch(clause, /PR total/); // no billed rounds ⇒ no spend clause at all
  });

  test('a PR that switched providers mid-flight reports TWO totals and never sums across bases', () => {
    const clause = renderPrTotal(
      { basis: 'subscription', notionalUsd: 20 },
      prior({ usd: 1.20, count: 2, notionalUsd: 20, notionalCount: 1 }),
    );
    assert.match(clause, /PR total \$1\.2000 across 2 rounds/);
    assert.match(clause, /PR list-price total \$40\.0000 across 2 rounds/);
    assert.doesNotMatch(clause, /41\.2000/); // the blended number that must never exist
  });

  test('a subscription round with no list price makes the notional total an honest lower bound', () => {
    const clause = renderPrTotal({ basis: 'subscription', notionalUsd: null }, prior({ notionalUsd: 10, notionalCount: 1 }));
    assert.match(clause, /PR list-price total \$10\.0000\+ across 2 rounds, 1 with unknown cost/);
  });
});

describe('costWarning', () => {
  test('null when cost is reported — no warning for a fully-priced run', () => {
    assert.equal(costWarning({ tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'dollars', usd: 0.1 } }, CODEX_CONFIG), null);
  });

  // "Engine reported nothing" now arrives in two shapes — no usage record at all, and a record
  // carrying only the host-stamped span (zai-timing-31d.4). Both warn with the same words.
  test('a span-only usage warns exactly as a null usage does', () => {
    const expected = costWarning(null, CODEX_CONFIG);
    assert.match(expected, /reported no token usage/);
    assert.equal(costWarning({ span: { from: '2026-08-22T03:30:00.000Z', to: '2026-08-22T03:35:00.000Z' } }, CODEX_CONFIG), expected);
  });

  test('no-price names the price table and the model to add', () => {
    const w = costWarning({ tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'unpriced', reason: 'no-price' } }, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.match(w, /price-table entry for codex\/gpt-future/);
    assert.match(w, /PRICE_SOURCES/);
  });

  // [LAW:no-silent-failure] The remedy has to match the cause. A model that IS in the table must not
  // be reported with "add the model to PRICE_SOURCES" — that sends the maintainer to edit a table that
  // is already correct, the same misattribution as blaming a time budget for a quota wall.
  test('schedule-gap says the model is present and its schedule declined — never "add the model"', () => {
    const w = costWarning(
      { tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'unpriced', reason: 'schedule-gap' } },
      { ...CODEX_CONFIG, model: 'gpt-5.6-sol' },
    );
    assert.match(w, /is in the price table/);
    assert.doesNotMatch(w, /PRICE_SOURCES/);
  });

  test('an unlisted unpriced reason throws rather than borrowing another reason\'s remedy', () => {
    assert.throws(
      () => costWarning({ tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'unpriced', reason: 'invented' } }, CODEX_CONFIG),
      /unknown unpriced reason/,
    );
  });

  test('not-reported names the engine, never the price table — the codex/claude causes do not conflate', () => {
    const w = costWarning({ tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'unpriced', reason: 'not-reported' } }, ANTHROPIC_CONFIG);
    assert.match(w, /claude-code reported no cost/);
    assert.doesNotMatch(w, /price-table|PRICES_PER_MILLION/);
  });

  test('a fully-reported subscription run does not warn — its figure is present, it is simply not spend', () => {
    const usage = { tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'subscription', notionalUsd: 63.59 } };
    assert.equal(costWarning(usage, SUBSCRIPTION_CONFIG), null);
  });

  // [LAW:no-silent-failure] The spend is known ($0) either way, but losing the list price loses the
  // one number that answers "is the subscription worth it?" — so it is operator news, not silence.
  test('a subscription run with no list price warns, and says the spend is zero regardless', () => {
    const usage = { tokens: { inputCacheMiss: 1, inputCacheHit: 0, output: 1 }, cost: { basis: 'subscription', notionalUsd: null } };
    const w = costWarning(usage, SUBSCRIPTION_CONFIG);
    assert.match(w, /subscription/);
    assert.match(w, /list-price figure is unavailable/);
    assert.doesNotMatch(w, /price-table|PRICES_PER_MILLION/);
  });

  test('no usage at all warns that the cost line is omitted', () => {
    assert.match(costWarning(null, CODEX_CONFIG), /no token usage/);
  });
});

describe('formatTokenCount', () => {
  test('groups thousands', () => {
    assert.equal(formatTokenCount(1234567), '1,234,567');
    assert.equal(formatTokenCount(0), '0');
  });
});
