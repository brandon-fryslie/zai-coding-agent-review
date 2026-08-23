'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { extractUsage: codexExtractUsage } = require('../src/engine/codex');
const { extractUsage: claudeExtractUsage } = require('../src/engine/claude-code');
const {
  computeCostUsd,
  renderCostLine,
  renderPrTotal,
  costMarker,
  parseCostMarker,
  parseCost,
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
  billed: { usd, count, unknownCount },
  notional: { usd: notionalUsd, count: notionalCount, unknownCount: notionalUnknownCount },
});

// --- computeCostUsd ---

describe('computeCostUsd', () => {
  test('prices non-cached input, cached input, and output at their distinct rates', () => {
    // gpt-5.4-mini: input 0.75, cachedInput 0.075, output 4.50 (per 1M).
    // 6,000 non-cached in @0.75 + 4,000 cached @0.075 + 2,000 out @4.50 = 13,800 / 1e6.
    const cost = computeCostUsd(
      { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 4_000 },
      'gpt-5.4-mini',
    );
    assert.ok(Math.abs(cost - 0.0138) < 1e-9, `expected ~0.0138, got ${cost}`);
  });

  test('a non-finite result (NaN token count) is null (unknown), never a NaN cost', () => {
    assert.equal(computeCostUsd({ inputTokens: NaN, outputTokens: 2_000 }, 'gpt-5.4-mini'), null);
  });

  test('treats absent cached tokens as zero (all input billed at full rate)', () => {
    const cost = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, 'gpt-5.5');
    assert.equal(cost, 5.00);
  });

  test('prices deepseek and glm models from the same table (one mechanism, every provider)', () => {
    // deepseek-v4-pro: input 0.435, output 0.87. 1M in + 1M out = 0.435 + 0.87 = 1.305.
    const ds = computeCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'deepseek-v4-pro');
    assert.ok(Math.abs(ds - 1.305) < 1e-9, `deepseek: got ${ds}`);
    // glm-5.1: input 1.40, cachedInput 0.26, output 4.40. 800k non-cached @1.40 + 200k @0.26 + 100k out @4.40.
    const glm = computeCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 }, 'glm-5.1');
    const expected = (800_000 * 1.40 + 200_000 * 0.26 + 100_000 * 4.40) / 1e6;
    assert.ok(Math.abs(glm - expected) < 1e-9, `glm: got ${glm}`);
  });

  test('returns null for a model with no price-table entry — never a fabricated zero', () => {
    assert.equal(computeCostUsd({ inputTokens: 100, outputTokens: 100 }, 'gpt-unknown'), null);
  });

  test('every default model the providers ship has a price-table entry', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'deepseek-v4-pro', 'glm-5.1']) {
      assert.ok(PRICES_PER_MILLION[model], `missing price for ${model}`);
    }
  });
});

// --- codexExtractUsage (real codex exec --json shape) ---

describe('codexExtractUsage', () => {
  test('reads usage from the final turn.completed and computes USD from the price table', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":1000,"output_tokens":500,"reasoning_output_tokens":200}}',
    ].join('\n');
    const usage = codexExtractUsage(stdout, CODEX_CONFIG);
    assert.equal(usage.inputTokens, 5000);
    assert.equal(usage.outputTokens, 500);
    assert.equal(usage.cost.basis, 'dollars');
    // (4000*0.75 + 1000*0.075 + 500*4.50)/1e6 = (3000 + 75 + 2250)/1e6 = 0.005325
    assert.ok(Math.abs(usage.cost.usd - 0.005325) < 1e-9, `got ${usage.cost.usd}`);
  });

  test('the last turn.completed wins when several are emitted', () => {
    const stdout = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":9000,"output_tokens":300}}',
    ].join('\n');
    const usage = codexExtractUsage(stdout, CODEX_CONFIG);
    assert.equal(usage.inputTokens, 9000);
    assert.equal(usage.outputTokens, 300);
  });

  test('cost is unavailable with reason no-price (tokens still reported) when the model has no price', () => {
    const stdout = '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":10}}';
    const usage = codexExtractUsage(stdout, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.equal(usage.inputTokens, 100);
    assert.deepEqual(usage.cost, { basis: 'unpriced', reason: 'no-price' });
  });

  test('returns null when no turn.completed carries usage', () => {
    const stdout = '{"type":"thread.started","thread_id":"abc"}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG), null);
  });

  test('an empty usage object is reported as no usage, not a $0.00 run', () => {
    const stdout = '{"type":"turn.completed","usage":{}}';
    assert.equal(codexExtractUsage(stdout, CODEX_CONFIG), null);
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
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG);
    assert.equal(usage.inputTokens, 1000 + 4000 + 250);
    assert.equal(usage.outputTokens, 500);
    assert.deepEqual(usage.cost, { basis: 'dollars', usd: 0.0123 });
  });

  test('cost is unavailable with reason not-reported when a genuine Anthropic envelope omits total_cost_usd', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG);
    assert.equal(usage.inputTokens, 10);
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
    const usage = claudeExtractUsage(stdout, DEEPSEEK_CONFIG);
    assert.equal(usage.inputTokens, 1_000_000);
    assert.equal(usage.cost.basis, 'dollars');
    // deepseek-v4-pro: 1M in @0.435 + 1M out @0.87 = 1.305 — not the 0.5 Anthropic figure.
    assert.ok(Math.abs(usage.cost.usd - 1.305) < 1e-9, `got ${usage.cost.usd}`);
  });

  test('cache reads bill at the discounted cached rate, fresh + cache writes at the full rate', () => {
    const stdout = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1_000_000, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 250_000, output_tokens: 100_000 },
    });
    const usage = claudeExtractUsage(stdout, DEEPSEEK_CONFIG);
    // full-rate = fresh(1M) + cache_creation(250k) = 1.25M @0.435; cached = cache_read(500k) @0.003625; out 100k @0.87.
    const expected = (1_250_000 * 0.435 + 500_000 * 0.003625 + 100_000 * 0.87) / 1e6;
    assert.ok(Math.abs(usage.cost.usd - expected) < 1e-9, `got ${usage.cost.usd}, expected ${expected}`);
  });

  test('a foreign endpoint whose model is not in the table reports no-price (tokens still shown)', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const unlisted = { engine: 'claude-code', model: 'glm-unreleased', endpoint: { baseUrl: 'https://api.z.ai/api/anthropic', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, unlisted).cost, { basis: 'unpriced', reason: 'no-price' });
  });

  test('a lookalike host (notanthropic.com) is classified foreign, not trusted as Anthropic', () => {
    // [LAW:types-are-the-program] regression: endsWith('anthropic.com') wrongly accepted this host.
    // model not in the table → no-price (proves total_cost_usd was NOT used); genuine host → total_cost_usd.
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const lookalike = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.notanthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, lookalike).cost, { basis: 'unpriced', reason: 'no-price' });
    const sub = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, sub).cost, { basis: 'dollars', usd: 0.5 });
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2: a subscription run's figure is Anthropic LIST
  // PRICE for tokens billed to plan quota. It is EMITTED — the figure is the deliverable, it answers
  // "is the subscription cheaper than the API bill?" — under a distinctly-named field on a distinct
  // variant, so no spend fold has a `usd` here to pick up.
  test('a subscription run reports its list price as NOTIONAL, never as spend', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 } });
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG).cost, { basis: 'subscription', notionalUsd: 0.42 });
    // the structural exclusion: there is no `usd` field for a spend fold to read, at all.
    assert.equal('usd' in claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG).cost, false);
  });

  // [LAW:no-silent-failure] AC for zai-billing-xl0.2: an omitted total_cost_usd under a subscription
  // is an unavailable NOTIONAL, never 0.00 — "we don't know the list price" and "the list price was
  // zero" are different facts and must not collapse. The basis stays subscription either way: what
  // the run cost in DOLLARS is known exactly (nothing); only its list price is missing.
  test('a subscription run with no total_cost_usd reports the notional as unavailable, not as zero', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG).cost, { basis: 'subscription', notionalUsd: null });
  });

  // A garbage total_cost_usd must not become a NaN notional that later renders "$NaN".
  test('a non-finite total_cost_usd under a subscription is an unavailable notional', () => {
    const stdout = '{"type":"result","total_cost_usd":"lots","usage":{"input_tokens":10,"output_tokens":5}}';
    assert.deepEqual(claudeExtractUsage(stdout, SUBSCRIPTION_CONFIG).cost, { basis: 'subscription', notionalUsd: null });
  });

  test('returns null when the envelope has no usage', () => {
    assert.equal(claudeExtractUsage('{"type":"result","result":"x"}', ANTHROPIC_CONFIG), null);
  });

  test('returns null when stdout is not a parseable envelope', () => {
    assert.equal(claudeExtractUsage('not json at all', ANTHROPIC_CONFIG), null);
  });
});

// --- renderCostLine (pure formatting) ---

describe('renderCostLine', () => {
  test('renders dollars, comma-grouped tokens, and the engine/model tag', () => {
    const line = renderCostLine({ inputTokens: 12345, outputTokens: 6789, cost: { basis: 'dollars', usd: 0.0123 } }, CODEX_CONFIG);
    assert.match(line, /\$0\.0123/);
    assert.match(line, /12,345 in \/ 6,789 out tokens/);
    assert.match(line, /codex\/gpt-5\.4-mini/);
  });

  test('marks every cost as an estimate — codex (list-price table) included, not just claude', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { basis: 'dollars', usd: 0.5 } }, CODEX_CONFIG);
    assert.match(line, /· est\.$|· est\._$/);
  });

  test('a non-z.ai claude-code run is still marked an estimate (total_cost_usd is client-side)', () => {
    const anthropicConfig = { engine: 'claude-code', model: 'claude-x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { basis: 'dollars', usd: 0.5 } }, anthropicConfig);
    assert.match(line, /· est\._$/);
    assert.doesNotMatch(line, /z\.ai/);
  });

  test('a z.ai/deepseek (foreign) claude-code run renders its own table-priced cost, never the Anthropic figure', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
    const dsLine = renderCostLine(claudeExtractUsage(stdout, DEEPSEEK_CONFIG), DEEPSEEK_CONFIG);
    assert.match(dsLine, /\$1\.3050/);          // deepseek-priced, not $0.5000
    assert.doesNotMatch(dsLine, /\$0\.5000/);
    assert.match(dsLine, /· est\._$/);
    const glmLine = renderCostLine(claudeExtractUsage(stdout, ZAI_CONFIG), ZAI_CONFIG);
    assert.match(glmLine, /Cost: \$/);          // glm-5.1 priced
    assert.doesNotMatch(glmLine, /unknown/);
  });

  test('shows cost as "unknown" (tokens still rendered) when cost is unavailable', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { basis: 'unpriced', reason: 'no-price' } }, CODEX_CONFIG);
    assert.match(line, /Cost: unknown/);
    assert.match(line, /100 in \/ 50 out tokens/);
  });

  test('returns empty string when there is no usage at all', () => {
    assert.equal(renderCostLine(null, CODEX_CONFIG), '');
  });

  test('no prior rounds → single-round line, no PR total (first review unchanged)', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { basis: 'dollars', usd: 0.02 } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior());
    assert.doesNotMatch(line, /PR total/);
    assert.match(line, /· est\._$/);
  });

  test('with prior rounds → appends a running PR total across all rounds', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { basis: 'dollars', usd: 0.03 } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior({ usd: 0.09, count: 2 }));
    assert.match(line, /\$0\.0300/);                          // this round
    assert.match(line, /PR total \$0\.1200 across 3 rounds/); // 0.09 prior + 0.03 this
  });

  test('an unknown-cost round makes the PR total a lower bound (+) and names the unpriced count', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { basis: 'unpriced', reason: 'no-price' } };
    const line = renderCostLine(usage, CODEX_CONFIG, prior({ usd: 0.09, count: 2, unknownCount: 1 }));
    assert.match(line, /PR total \$0\.0900\+ across 4 rounds, 2 with unknown cost/);
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2: the notional figure IS present in the footer —
  // it is the deliverable, not the hazard — but it is labelled as list price and the line leads with
  // the truth that nothing was billed.
  test('a subscription run renders its list price, labelled as not billed', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { basis: 'subscription', notionalUsd: 63.59 } };
    const line = renderCostLine(usage, SUBSCRIPTION_CONFIG);
    assert.match(line, /Not billed \(Claude subscription\)/);
    assert.match(line, /\$63\.5900 at Anthropic list price/);
    assert.match(line, /100 in \/ 50 out tokens/);
    assert.match(line, /· est\._$/);
  });

  test('a subscription run with no list price says so — never "$0.0000"', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { basis: 'subscription', notionalUsd: null } };
    const line = renderCostLine(usage, SUBSCRIPTION_CONFIG);
    assert.match(line, /Not billed \(Claude subscription\)/);
    assert.match(line, /list price not reported/);
    assert.doesNotMatch(line, /\$0\.0000/);
  });
});

describe('cost marker (machine-readable per-round cost)', () => {
  test('round-trips an available cost', () => {
    assert.equal(parseCostMarker(costMarker({ basis: 'dollars', usd: 0.1234 })), 0.1234);
  });
  test('records unavailable cost as the string "unknown"', () => {
    assert.equal(parseCostMarker(costMarker({ basis: 'unpriced', reason: 'no-price' })), 'unknown');
    assert.equal(parseCostMarker(costMarker(null)), 'unknown');
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
    assert.match(costMarker({ basis: 'dollars', usd: 1 }), /^<!-- .* -->$/);
  });
  test('takes the LAST marker — a body quoting a marker in prose + the real one at the end', () => {
    // A review OF this feature could quote a marker in its summary; the real cost marker trails it.
    const body = `Findings: the format is ${costMarker({ basis: 'dollars', usd: 9.99 })} for example.\n\n`
      + `footer\n\n${costMarker({ basis: 'dollars', usd: 0.42 })}\n\n<!-- copirate-code-review-agent -->`;
    assert.equal(parseCostMarker(body), 0.42); // the real trailing marker, not the quoted 9.99
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.2, the STRUCTURAL half. Every spend fold in this
  // codebase reads markers through parseCostMarker; a subscription review writes a differently-named
  // marker, so the spend readers have nothing to match. This is the property that makes the exclusion
  // impossible to forget rather than merely documented.
  test('a subscription cost writes a NOTIONAL marker that no spend reader can see', () => {
    const marker = costMarker({ basis: 'subscription', notionalUsd: 63.59 });
    assert.match(marker, /^<!-- agent-review-notional-usd:63\.590000 -->$/);
    assert.equal(parseCostMarker(marker), null); // invisible to every spend fold, by construction
  });

  test('a subscription cost with no list price still writes a notional marker, valued unknown', () => {
    const marker = costMarker({ basis: 'subscription', notionalUsd: null });
    assert.equal(marker, '<!-- agent-review-notional-usd:unknown -->');
    assert.equal(parseCostMarker(marker), null);
  });

  test('parseCost round-trips every basis back to the value that wrote it', () => {
    assert.deepEqual(parseCost(costMarker({ basis: 'dollars', usd: 0.1234 })), { basis: 'dollars', usd: 0.1234 });
    assert.deepEqual(parseCost(costMarker({ basis: 'subscription', notionalUsd: 63.59 })), { basis: 'subscription', notionalUsd: 63.59 });
    assert.deepEqual(parseCost(costMarker({ basis: 'subscription', notionalUsd: null })), { basis: 'subscription', notionalUsd: null });
    assert.deepEqual(parseCost(costMarker({ basis: 'unpriced', reason: 'no-price' })), { basis: 'unpriced', reason: 'not-reported' });
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
      costMarker({ basis: 'dollars', usd: 0.4200 }),
    ].join('\n');
    assert.deepEqual(parseCost(body), { basis: 'dollars', usd: 0.42 });
  });

  test('a subscription review that QUOTES a spend marker in its prose is still subscription', () => {
    const body = [
      'A paid round writes <!-- agent-review-cost-usd:0.420000 --> instead.',
      costMarker({ basis: 'subscription', notionalUsd: 63.59 }),
    ].join('\n');
    assert.deepEqual(parseCost(body), { basis: 'subscription', notionalUsd: 63.59 });
  });
});

// --- sumCost (the "never add across bases" rule) ---

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
    assert.equal(costWarning({ inputTokens: 1, outputTokens: 1, cost: { basis: 'dollars', usd: 0.1 } }, CODEX_CONFIG), null);
  });

  test('no-price names the price table and the model to add', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { basis: 'unpriced', reason: 'no-price' } }, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.match(w, /price-table entry for codex\/gpt-future/);
    assert.match(w, /PRICES_PER_MILLION/);
  });

  test('not-reported names the engine, never the price table — the codex/claude causes do not conflate', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { basis: 'unpriced', reason: 'not-reported' } }, ANTHROPIC_CONFIG);
    assert.match(w, /claude-code reported no cost/);
    assert.doesNotMatch(w, /price-table|PRICES_PER_MILLION/);
  });

  test('a fully-reported subscription run does not warn — its figure is present, it is simply not spend', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cost: { basis: 'subscription', notionalUsd: 63.59 } };
    assert.equal(costWarning(usage, SUBSCRIPTION_CONFIG), null);
  });

  // [LAW:no-silent-failure] The spend is known ($0) either way, but losing the list price loses the
  // one number that answers "is the subscription worth it?" — so it is operator news, not silence.
  test('a subscription run with no list price warns, and says the spend is zero regardless', () => {
    const usage = { inputTokens: 1, outputTokens: 1, cost: { basis: 'subscription', notionalUsd: null } };
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
