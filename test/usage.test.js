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
    assert.equal(usage.cost.available, true);
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
    assert.deepEqual(usage.cost, { available: false, reason: 'no-price' });
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
    assert.deepEqual(usage.cost, { available: true, usd: 0.0123 });
  });

  test('cost is unavailable with reason not-reported when a genuine Anthropic envelope omits total_cost_usd', () => {
    const stdout = JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5 } });
    const usage = claudeExtractUsage(stdout, ANTHROPIC_CONFIG);
    assert.equal(usage.inputTokens, 10);
    assert.deepEqual(usage.cost, { available: false, reason: 'not-reported' });
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
    assert.equal(usage.cost.available, true);
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
    assert.deepEqual(claudeExtractUsage(stdout, unlisted).cost, { available: false, reason: 'no-price' });
  });

  test('a lookalike host (notanthropic.com) is classified foreign, not trusted as Anthropic', () => {
    // [LAW:types-are-the-program] regression: endsWith('anthropic.com') wrongly accepted this host.
    // model not in the table → no-price (proves total_cost_usd was NOT used); genuine host → total_cost_usd.
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } });
    const lookalike = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.notanthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, lookalike).cost, { available: false, reason: 'no-price' });
    const sub = { engine: 'claude-code', model: 'x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    assert.deepEqual(claudeExtractUsage(stdout, sub).cost, { available: true, usd: 0.5 });
  });

  // [LAW:verifiable-goals] AC for zai-billing-xl0.1: a subscription run is Anthropic BY CONSTRUCTION —
  // the variant carries no baseUrl to sniff, so the classification comes from the type, not a hostname.
  // NOTE: the figure it yields is Anthropic LIST price for a run billed to plan quota, so it is
  // notional, not spend. Discriminating that is zai-billing-xl0.2's job, ranked immediately after.
  test('a subscription run is Anthropic by construction, with no baseUrl to inspect', () => {
    const stdout = JSON.stringify({ type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 } });
    const subscription = {
      engine: 'claude-code',
      model: 'claude-sonnet-5',
      endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', credential: { kind: 'oauth', value: 'sk-ant-oat01-x' } },
    };
    assert.deepEqual(claudeExtractUsage(stdout, subscription).cost, { available: true, usd: 0.42 });
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
    const line = renderCostLine({ inputTokens: 12345, outputTokens: 6789, cost: { available: true, usd: 0.0123 } }, CODEX_CONFIG);
    assert.match(line, /\$0\.0123/);
    assert.match(line, /12,345 in \/ 6,789 out tokens/);
    assert.match(line, /codex\/gpt-5\.4-mini/);
  });

  test('marks every cost as an estimate — codex (list-price table) included, not just claude', () => {
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.5 } }, CODEX_CONFIG);
    assert.match(line, /· est\.$|· est\._$/);
  });

  test('a non-z.ai claude-code run is still marked an estimate (total_cost_usd is client-side)', () => {
    const anthropicConfig = { engine: 'claude-code', model: 'claude-x', endpoint: { baseUrl: 'https://api.anthropic.com', credential: { kind: 'api-key', value: 'k' } } };
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.5 } }, anthropicConfig);
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
    const line = renderCostLine({ inputTokens: 100, outputTokens: 50, cost: { available: false, reason: 'no-price' } }, CODEX_CONFIG);
    assert.match(line, /Cost: unknown/);
    assert.match(line, /100 in \/ 50 out tokens/);
  });

  test('returns empty string when there is no usage at all', () => {
    assert.equal(renderCostLine(null, CODEX_CONFIG), '');
  });

  test('no prior rounds → single-round line, no PR total (first review unchanged)', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.02 } };
    const line = renderCostLine(usage, CODEX_CONFIG, { usd: 0, knownRounds: 0, unknownRounds: 0 });
    assert.doesNotMatch(line, /PR total/);
    assert.match(line, /· est\._$/);
  });

  test('with prior rounds → appends a running PR total across all rounds', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { available: true, usd: 0.03 } };
    const line = renderCostLine(usage, CODEX_CONFIG, { usd: 0.09, knownRounds: 2, unknownRounds: 0 });
    assert.match(line, /\$0\.0300/);                          // this round
    assert.match(line, /PR total \$0\.1200 across 3 rounds/); // 0.09 prior + 0.03 this
  });

  test('an unknown-cost round makes the PR total a lower bound (+) and names the unpriced count', () => {
    const usage = { inputTokens: 100, outputTokens: 50, cost: { available: false, reason: 'no-price' } };
    const line = renderCostLine(usage, CODEX_CONFIG, { usd: 0.09, knownRounds: 2, unknownRounds: 1 });
    assert.match(line, /PR total \$0\.0900\+ across 4 rounds, 2 with unknown cost/);
  });
});

describe('cost marker (machine-readable per-round cost)', () => {
  test('round-trips an available cost', () => {
    assert.equal(parseCostMarker(costMarker({ available: true, usd: 0.1234 })), 0.1234);
  });
  test('records unavailable cost as the string "unknown"', () => {
    assert.equal(parseCostMarker(costMarker({ available: false, reason: 'no-price' })), 'unknown');
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
    assert.match(costMarker({ available: true, usd: 1 }), /^<!-- .* -->$/);
  });
  test('takes the LAST marker — a body quoting a marker in prose + the real one at the end', () => {
    // A review OF this feature could quote a marker in its summary; the real cost marker trails it.
    const body = `Findings: the format is ${costMarker({ available: true, usd: 9.99 })} for example.\n\n`
      + `footer\n\n${costMarker({ available: true, usd: 0.42 })}\n\n<!-- copirate-code-review-agent -->`;
    assert.equal(parseCostMarker(body), 0.42); // the real trailing marker, not the quoted 9.99
  });
});

describe('renderPrTotal', () => {
  test('empty when there is no prior-cost value at all', () => {
    assert.equal(renderPrTotal({ available: true, usd: 1 }, null), '');
  });
  test('empty when there are zero prior rounds (the first review)', () => {
    assert.equal(renderPrTotal({ available: true, usd: 1 }, { usd: 0, knownRounds: 0, unknownRounds: 0 }), '');
  });
  test('available this-round + mixed known/unknown prior → total plus a "+" and the unpriced count', () => {
    const clause = renderPrTotal({ available: true, usd: 0.03 }, { usd: 0.10, knownRounds: 2, unknownRounds: 1 });
    assert.match(clause, /PR total \$0\.1300\+ across 4 rounds, 1 with unknown cost/); // 0.10 + 0.03, 1 unpriced
  });
});

describe('costWarning', () => {
  test('null when cost is reported — no warning for a fully-priced run', () => {
    assert.equal(costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: true, usd: 0.1 } }, CODEX_CONFIG), null);
  });

  test('no-price names the price table and the model to add', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: false, reason: 'no-price' } }, { ...CODEX_CONFIG, model: 'gpt-future' });
    assert.match(w, /price-table entry for codex\/gpt-future/);
    assert.match(w, /PRICES_PER_MILLION/);
  });

  test('not-reported names the engine, never the price table — the codex/claude causes do not conflate', () => {
    const w = costWarning({ inputTokens: 1, outputTokens: 1, cost: { available: false, reason: 'not-reported' } }, ANTHROPIC_CONFIG);
    assert.match(w, /claude-code reported no cost/);
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
