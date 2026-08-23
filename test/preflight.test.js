'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyProbe, probeConfig, preflight } = require('../src/preflight');

const anthropicConfig = (name, overrides = {}) => ({
  name,
  engine: 'claude-code',
  model: 'deepseek-v4-pro',
  endpoint: { kind: 'anthropic-messages', auth: { method: 'api-key', baseUrl: 'https://api.example.com/anthropic', credential: 'k' }, ...overrides },
});

// A fake fetch that yields a fixed status, or throws to simulate a network failure.
const fetchStatus = (status) => async () => ({ status });
const fetchThrow = (err) => async () => { throw err; };

test('classifyProbe: 2xx is healthy', () => {
  assert.deepEqual(classifyProbe({ status: 200 }), { healthy: true, reason: 'ok', hint: null });
  assert.equal(classifyProbe({ status: 204 }).healthy, true);
});

test('classifyProbe: 401/403 is an auth failure naming the credential', () => {
  for (const status of [401, 403]) {
    const v = classifyProbe({ status });
    assert.equal(v.healthy, false);
    assert.equal(v.reason, 'auth');
    assert.match(v.hint, /key is missing, wrong, or expired/);
  }
});

test('classifyProbe: 404 points at base URL / model', () => {
  const v = classifyProbe({ status: 404 });
  assert.equal(v.healthy, false);
  assert.equal(v.reason, 'endpoint');
  assert.match(v.hint, /base URL/);
});

test('classifyProbe: a network error is unreachable, not a false-OK', () => {
  const v = classifyProbe({ networkError: 'getaddrinfo ENOTFOUND' });
  assert.equal(v.healthy, false);
  assert.equal(v.reason, 'unreachable');
});

test('classifyProbe: other statuses (400, 5xx) are reachable-and-authed, never blocking', () => {
  // Auth failures are 401/403; anything else means the credential got past the door, so the probe
  // must not block a review that would otherwise run.
  for (const status of [400, 422, 429, 500, 503]) {
    const v = classifyProbe({ status });
    assert.equal(v.healthy, true, `HTTP ${status} must not block`);
    assert.equal(v.reason, 'reachable');
  }
});

test('probeConfig: healthy endpoint', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchStatus(200));
  assert.deepEqual(r, { name: 'deepseek-default', skipped: false, healthy: true, reason: 'ok', hint: null });
});

test('probeConfig: bad key', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchStatus(401));
  assert.equal(r.healthy, false);
  assert.equal(r.reason, 'auth');
});

test('probeConfig: a thrown fetch becomes unreachable', async () => {
  const r = await probeConfig(anthropicConfig('deepseek-default'), fetchThrow(new Error('connect ECONNREFUSED')));
  assert.equal(r.healthy, false);
  assert.equal(r.reason, 'unreachable');
  assert.match(r.hint, /ECONNREFUSED/);
});

test('probeConfig: an unobserved endpoint kind is skipped, never falsely probed', async () => {
  const config = {
    name: 'codex-default', engine: 'codex', model: 'gpt-5.4-mini',
    endpoint: { kind: 'openai-responses', auth: { method: 'api-key', baseUrl: 'https://api.openai.com/v1', credential: 'k' } },
  };
  let called = false;
  const r = await probeConfig(config, async () => { called = true; return { status: 200 }; });
  assert.equal(called, false, 'must not hit the network for an unobserved kind');
  assert.equal(r.skipped, true);
});

// [LAW:verifiable-goals] AC for zai-billing-xl0.1: the subscription variant is UNPROBED. A guessed
// OAuth probe (beta headers unobserved here) would reject a working subscription before the engine
// ever ran — worse than no probe. The skip must be loud and must name the auth method, since
// 'anthropic-messages' on its own IS probed under api-key auth.
test('probeConfig: a subscription auth is skipped loudly, never probed with a guessed request', async () => {
  const config = {
    name: 'claude-subscription-default', engine: 'claude-code', model: 'claude-sonnet-5',
    endpoint: { kind: 'anthropic-messages', auth: { method: 'subscription', credential: 'sk-ant-oat01-x' } },
  };
  let called = false;
  const r = await probeConfig(config, async () => { called = true; return { status: 401 }; });
  assert.equal(called, false, 'must not hit the network for an unobserved auth method');
  assert.equal(r.skipped, true);
  assert.match(r.hint, /auth method 'subscription'/);
});

test('preflight: a subscription-only chain stays ok — an unprobed config never blocks the review', async () => {
  const chain = [{
    name: 'claude-subscription-default', engine: 'claude-code', model: 'claude-sonnet-5',
    endpoint: { kind: 'anthropic-messages', auth: { method: 'subscription', credential: 'k' } },
  }];
  const { ok, results } = await preflight(chain, async () => { throw new Error('must not be called'); });
  assert.equal(ok, true);
  assert.equal(results[0].skipped, true);
});

// [LAW:verifiable-goals] Regression: a SKIPPED config is unproven, not absent. Filtering skipped
// configs out of the verdict false-blocked this exact chain — the one a subscription user most likely
// has — before any engine could spawn.
test('preflight: a skipped primary in front of a DEAD probed fallback still passes', async () => {
  const chain = [
    {
      name: 'claude-subscription-default', engine: 'claude-code', model: 'claude-sonnet-5',
      endpoint: { kind: 'anthropic-messages', auth: { method: 'subscription', credential: 'k' } },
    },
    anthropicConfig('deepseek-fallback'),
  ];
  const { ok, results } = await preflight(chain, async () => ({ status: 401 }));
  assert.equal(results[0].skipped, true, 'subscription primary must be skipped, not probed');
  assert.equal(results[1].healthy, false, 'the api-key fallback is genuinely down');
  assert.equal(ok, true, 'an unproven primary must not be treated as proven down');
});

test('preflight: every config probed and every one down is still a hard fail', async () => {
  const chain = [anthropicConfig('primary'), anthropicConfig('fallback')];
  const { ok } = await preflight(chain, async () => ({ status: 401 }));
  assert.equal(ok, false, 'nothing unproven and nothing healthy — the chain really is dead');
});

test('preflight: chain is ok when any config is healthy (failover survives a dead primary)', async () => {
  const chain = [anthropicConfig('primary'), anthropicConfig('fallback')];
  // Probed in chain order: primary down (401), fallback healthy (200).
  let i = 0;
  const fetchSeq = async () => ({ status: [401, 200][i++] });
  const { ok, results } = await preflight(chain, fetchSeq);
  assert.equal(ok, true);
  assert.equal(results[0].healthy, false);
  assert.equal(results[1].healthy, true);
});

test('preflight: chain fails only when every probed config is down', async () => {
  const chain = [anthropicConfig('primary'), anthropicConfig('fallback')];
  const { ok, results } = await preflight(chain, fetchStatus(401));
  assert.equal(ok, false);
  assert.equal(results.every(r => !r.healthy), true);
});

test('preflight: all-skipped chain stays ok (nothing was actually validated)', async () => {
  const chain = [{
    name: 'codex-default', engine: 'codex', model: 'm',
    endpoint: { kind: 'openai-responses', auth: { method: 'api-key', baseUrl: 'https://x', credential: 'k' } },
  }];
  let called = false;
  const { ok, results } = await preflight(chain, async () => { called = true; return { status: 200 }; });
  assert.equal(called, false);
  assert.equal(ok, true);
  assert.equal(results[0].skipped, true);
});
