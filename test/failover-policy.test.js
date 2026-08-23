'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  TransientError,
  ProtocolError,
  isRetryableSpawnError,
  produceReview,
  buildAttributionFooter,
  retryTransientSpawn,
  classifyTransient,
  TRANSIENT_SPAWN_ATTEMPTS,
  MAX_CHAIN_SWEEPS,
} = require('../src/failover');

// Stub config factory — minimal ReviewConfig values needed by the policy and footer.
function cfg(name, engine = 'claude-code', model = 'glm-5.1', reasoning) {
  const c = { name, engine, model, endpoint: { kind: 'anthropic-messages', baseUrl: 'https://x', apiKey: 'k' } };
  if (reasoning) c.reasoning = reasoning;
  return c;
}

const FAKE_REVIEW = { summary: 'ok', findings: [] };
const NO_SLEEP = async () => {}; // [LAW:effects-at-boundaries] inject no-op sleep for fast tests

// Produce a produceOnce stub that:
//   - throws TransientError for the first `throwCount` calls on each config
//   - then returns FAKE_REVIEW
// callLog receives { config, attempt } for every call.
function makeStub(throwsByConfig = {}, callLog = []) {
  const counters = {};
  return async function produceOnce(config) {
    const count = (counters[config.name] = (counters[config.name] ?? 0) + 1);
    callLog.push({ config: config.name, attempt: count });
    const limit = throwsByConfig[config.name] ?? 0;
    if (count <= limit) throw new TransientError(`overloaded on ${config.name}`);
    return FAKE_REVIEW;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// retryTransientSpawn — spawn-level transient recovery (a different axis from failover)
// ────────────────────────────────────────────────────────────────────────────

describe('retryTransientSpawn', () => {
  it('returns the thunk value on first success, with no retry', async () => {
    let calls = 0;
    let slept = 0;
    const value = await retryTransientSpawn(
      async () => { calls++; return 'ok'; },
      { sleepFn: async () => { slept++; } },
    );
    assert.equal(value, 'ok');
    assert.equal(calls, 1);
    assert.equal(slept, 0);
  });

  it('retries on TransientError then returns the eventual success', async () => {
    let calls = 0;
    const retries = [];
    const value = await retryTransientSpawn(
      async () => { calls++; if (calls < 3) throw new TransientError('terminated'); return 'recovered'; },
      { sleepFn: async () => {}, onRetry: (info) => retries.push(info.attempt) },
    );
    assert.equal(value, 'recovered');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]); // onRetry fires before each of the two retries
  });

  it('surfaces a non-transient error immediately, without retrying', async () => {
    let calls = 0;
    const fatal = new Error('bad envelope');
    await assert.rejects(
      () => retryTransientSpawn(async () => { calls++; throw fatal; }, { sleepFn: async () => {} }),
      err => err === fatal,
    );
    assert.equal(calls, 1);
  });

  it('rethrows the last TransientError after exhausting the attempt budget (never swallowed)', async () => {
    let calls = 0;
    let slept = 0;
    const last = new TransientError('still terminated');
    await assert.rejects(
      () => retryTransientSpawn(
        async () => { calls++; throw calls === TRANSIENT_SPAWN_ATTEMPTS ? last : new TransientError('terminated'); },
        { sleepFn: async () => { slept++; } },
      ),
      err => err === last && err instanceof TransientError,
    );
    assert.equal(calls, TRANSIENT_SPAWN_ATTEMPTS); // 1 initial + (ATTEMPTS-1) retries
    assert.equal(slept, TRANSIENT_SPAWN_ATTEMPTS - 1); // no sleep after the final failed attempt
  });

  it('rejects a limit < 1 loud with a diagnostic (never an opaque throw undefined)', async () => {
    // An explicit limit:0 bypasses the destructuring default (which fires only on undefined); without
    // validation the loop runs zero times and `throw lastErr` throws undefined. [LAW:no-silent-failure]
    for (const bad of [0, -1, 1.5]) {
      await assert.rejects(
        () => retryTransientSpawn(async () => 'unreached', { limit: bad, sleepFn: async () => {} }),
        err => err instanceof Error && /limit must be a positive integer/.test(err.message),
      );
    }
  });

  it('honors the error Retry-After hint over backoff when choosing the delay', async () => {
    const delays = [];
    let calls = 0;
    await retryTransientSpawn(
      async () => { calls++; if (calls === 1) throw new TransientError('rate', 4321); return 'ok'; },
      { sleepFn: async (ms) => { delays.push(ms); } },
    );
    assert.deepEqual(delays, [4321]);
  });

  // ProtocolError shares TransientError's retry policy but is a DISTINCT type. A model that forgot
  // finish_review (or wrote no records) very likely succeeds on a fresh spawn, so it retries in place.
  it('retries on ProtocolError then returns the eventual success', async () => {
    let calls = 0;
    const retries = [];
    const value = await retryTransientSpawn(
      async () => { calls++; if (calls < 3) throw new ProtocolError('no finish_review'); return 'recovered'; },
      { sleepFn: async () => {}, onRetry: (info) => retries.push(info.attempt) },
    );
    assert.equal(value, 'recovered');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
  });

  it('rethrows the last ProtocolError after exhausting the budget, AS ITSELF (never a TransientError)', async () => {
    // [LAW:one-type-per-behavior] Same retry policy, different identity: an exhausted ProtocolError must
    // stay a ProtocolError so produceReview's `!instanceof TransientError` gate reds the run with the
    // precise cause instead of laundering a broken engine into config-level failover.
    let calls = 0;
    const last = new ProtocolError('still no finish_review');
    await assert.rejects(
      () => retryTransientSpawn(
        async () => { calls++; throw calls === TRANSIENT_SPAWN_ATTEMPTS ? last : new ProtocolError('slip'); },
        { sleepFn: async () => {} },
      ),
      err => err === last && err instanceof ProtocolError && !(err instanceof TransientError),
    );
    assert.equal(calls, TRANSIENT_SPAWN_ATTEMPTS);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isRetryableSpawnError — the single source of truth for which errors a re-spawn can fix
// ────────────────────────────────────────────────────────────────────────────

describe('isRetryableSpawnError', () => {
  it('is true for both retryable spawn types and false for a plain Error', () => {
    assert.equal(isRetryableSpawnError(new TransientError('net')), true);
    assert.equal(isRetryableSpawnError(new ProtocolError('slip')), true);
    assert.equal(isRetryableSpawnError(new Error('code bug')), false);
    assert.equal(isRetryableSpawnError(new TypeError('bad envelope')), false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// classifyTransient — the single source of truth for the shared transient vocabulary
// (429/529/network drop). Every engine adapter's classifyError consumes it, so a dropped
// socket is the same class regardless of engine. These assert the shared contract at its owner.
// ────────────────────────────────────────────────────────────────────────────

describe('classifyTransient', () => {
  const base = new Error('spawn failed');

  it('classifies 429 / rate-limit as a rate-limited TransientError', () => {
    const r = classifyTransient(base, 'HTTP 429 Too Many Requests');
    assert.ok(r instanceof TransientError);
    assert.match(r.message, /rate-limited/);
  });

  it('classifies 529 / overloaded as a TransientError', () => {
    assert.ok(classifyTransient(base, 'HTTP 529 overloaded') instanceof TransientError);
    assert.ok(classifyTransient(base, 'model is overloaded') instanceof TransientError);
  });

  it('classifies the network class — dropped socket / 5xx / Node socket codes', () => {
    assert.ok(classifyTransient(base, 'API Error: terminated') instanceof TransientError);
    assert.ok(classifyTransient(base, 'API Error: 503 Service Unavailable') instanceof TransientError);
    assert.ok(classifyTransient(base, 'read ECONNRESET') instanceof TransientError);
  });

  it('returns null (not the error) when no shared signal is present, so adapters can add their own class', () => {
    assert.equal(classifyTransient(base, 'unexpected token at line 42'), null);
  });

  it('does NOT false-match bare English phrases lacking the API-error anchor', () => {
    assert.equal(classifyTransient(base, 'the retry logic handles a socket hang up gracefully'), null);
    assert.equal(classifyTransient(base, 'the worker process at line 502 was cleanly shut down'), null);
  });

  it('attaches the Retry-After hint only via the injected extractor (per-engine bit)', () => {
    // Default: no extractor → null hint (codex/opencode fall to backoff).
    assert.equal(classifyTransient(base, 'HTTP 429 — retry-after: 90').retryAfterMs, null);
    // With an extractor (claude-code passes parseRetryAfterMs) → the server hint flows through.
    const withHint = classifyTransient(base, 'HTTP 429 — retry-after: 90', t => (/retry.?after[:\s]+(\d+)/i.exec(t) ? 90_000 : null));
    assert.equal(withHint.retryAfterMs, 90_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// buildAttributionFooter
// ────────────────────────────────────────────────────────────────────────────

describe('buildAttributionFooter', () => {
  it('formats config/engine/model', () => {
    const footer = buildAttributionFooter(cfg('zai-glm'));
    assert.match(footer, /config `zai-glm`/);
    assert.match(footer, /claude-code/);
    assert.match(footer, /glm-5\.1/);
  });

  it('includes reasoning when set', () => {
    const footer = buildAttributionFooter(cfg('codex-xhigh', 'codex', 'gpt-5.5', 'xhigh'));
    assert.match(footer, /reasoning `xhigh`/);
  });

  it('omits reasoning when not set', () => {
    const footer = buildAttributionFooter(cfg('no-reason', 'opencode', 'openai/gpt-4o'));
    assert.doesNotMatch(footer, /reasoning/);
  });

  it('uses placeholder when model is empty string', () => {
    const c = cfg('empty-model');
    c.model = '';
    const footer = buildAttributionFooter(c);
    assert.match(footer, /\(default model\)/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — success paths
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — success on first attempt', () => {
  it('returns review, configUsed=chain[0], attempts=1 on immediate success', async () => {
    const chain = [cfg('primary')];
    const result = await produceReview(chain, () => 'prompt', {}, makeStub(), NO_SLEEP);
    assert.deepEqual(result.review, FAKE_REVIEW);
    assert.equal(result.configUsed.name, 'primary');
    assert.equal(result.attempts, 1);
  });

  it('configUsed reflects the actual config that succeeded after first exhausts', async () => {
    const chain = [cfg('first'), cfg('second')];
    // first will throw 3 times (PER_CONFIG_LIMIT), then chain advances to second
    const callLog = [];
    const stub = makeStub({ first: 3 }, callLog);
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'second');
    // first exhausted 3 attempts, second succeeded on 1st = 4 total
    assert.equal(result.attempts, 4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — same-config retries (2 retries = 3 total per config)
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — same-config retry', () => {
  it('retries same config up to 3 total attempts before advancing', async () => {
    const chain = [cfg('a'), cfg('b')];
    const log = [];
    const stub = makeStub({ a: 2 }, log); // a throws twice, then succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'a');
    assert.equal(result.attempts, 3);
    assert.deepEqual(log.map(e => e.config), ['a', 'a', 'a']);
  });

  it('advances to next config after 3 transient failures on same config', async () => {
    const chain = [cfg('a'), cfg('b')];
    const log = [];
    const stub = makeStub({ a: 3 }, log); // a fails 3 times (all per-config budget); b succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'b');
    assert.equal(result.attempts, 4); // 3 on a + 1 on b
    assert.equal(log.filter(e => e.config === 'a').length, 3);
    assert.equal(log.filter(e => e.config === 'b').length, 1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — non-transient errors surface immediately
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — non-transient errors', () => {
  it('throws immediately on non-transient error, no failover', async () => {
    const chain = [cfg('a'), cfg('b')];
    const fatal = new Error('bad envelope');
    let bCalled = false;
    const stub = async (config) => {
      if (config.name === 'a') throw fatal;
      bCalled = true;
      return FAKE_REVIEW;
    };
    await assert.rejects(() => produceReview(chain, () => 'p', {}, stub, NO_SLEEP), err => err === fatal);
    assert.equal(bCalled, false, 'second config must never be tried on non-transient error');
  });

  it('does not retry non-transient even on chain with one entry', async () => {
    const chain = [cfg('only')];
    let callCount = 0;
    const stub = async () => { callCount++; throw new Error('non-transient'); };
    await assert.rejects(() => produceReview(chain, () => 'p', {}, stub, NO_SLEEP));
    assert.equal(callCount, 1);
  });

  it('throws a ProtocolError immediately — no retry, no config advancement', async () => {
    // [LAW:verifiable-goals] Locks in the deliberate asymmetry: retryTransientSpawn retries a
    // ProtocolError in place, but an EXHAUSTED one reaches produceReview as a non-TransientError and
    // reds the run at once — a persistent model protocol slip is a broken engine, not a provider blip,
    // so it must NOT trigger config-level failover. Guards against a future refactor of produceReview's
    // gate to isRetryableSpawnError, which would silently start failing a broken engine over to configs.
    const chain = [cfg('a'), cfg('b')];
    const slip = new ProtocolError('no finish_review');
    let bCalled = false;
    const stub = async (config) => {
      if (config.name === 'a') throw slip;
      bCalled = true;
      return FAKE_REVIEW;
    };
    await assert.rejects(
      () => produceReview(chain, () => 'p', {}, stub, NO_SLEEP),
      err => err === slip && err instanceof ProtocolError,
    );
    assert.equal(bCalled, false, 'a ProtocolError must never fail over to the next config');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — budget exhaustion
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — budget exhaustion', () => {
  it('throws immediately on empty chain (never assigns lastErr)', async () => {
    await assert.rejects(
      () => produceReview([], () => 'p', {}, makeStub(), NO_SLEEP),
      err => err instanceof Error && err.message.includes('chain must not be empty'),
    );
  });

  it('succeeds after 2 same-config retries; backoff sleeps fired once per retry', async () => {
    const chain = [cfg('only')];
    const transient = new TransientError('server down');
    let sleepCalls = 0;
    const trackSleep = async () => { sleepCalls++; };
    let calls = 0;
    const stub = async () => {
      calls++;
      if (calls <= 2) throw transient;
      return FAKE_REVIEW;
    };
    const result = await produceReview(chain, () => 'p', {}, stub, trackSleep);
    assert.equal(result.configUsed.name, 'only');
    assert.equal(result.attempts, 3);
    assert.equal(sleepCalls, 2);
  });

  it('throws last TransientError when budget is already expired on first failure', async () => {
    // budgetMs=0 makes deadline = Date.now()+0; the first attempt fails transient,
    // then budgetLeft === 0 fires and re-throws lastErr as the original TransientError.
    const chain = [cfg('only')];
    const transient = new TransientError('rate limited');
    const stub = async () => { throw transient; };
    await assert.rejects(
      () => produceReview(chain, () => 'p', {}, stub, NO_SLEEP, 0),
      err => err === transient && err instanceof TransientError,
    );
  });

  it('terminates chain-restart loop via sleepFn sentinel; each config gets full per-config retries', async () => {
    // Chain of two configs, both always transient. Sweep 1 produces:
    //   per-config sleeps: aa×2 + bb×2 = 4 (2 retries each; 3rd attempt just warns, no sleep)
    //   sweep-restart sleep:               1  → call 5 → SENTINEL
    // All sleepFn calls are fast async no-ops; SENTINEL propagates before sweep 2 starts.
    const chain = [cfg('aa'), cfg('bb')];
    const transient = new TransientError('never available');
    const SENTINEL = new Error('test-stop-sentinel');
    let sleepCallCount = 0;
    const sleepFn = async () => {
      sleepCallCount++;
      if (sleepCallCount >= 5) throw SENTINEL;
    };
    let callCount = 0;
    const stub = async () => { callCount++; throw transient; };
    await assert.rejects(
      () => produceReview(chain, () => 'p', {}, stub, sleepFn),
      err => err === SENTINEL,
    );
    // Both configs ran 3 attempts each in sweep 1 (6 total).
    // sleepFn was called exactly 5 times (4 per-config retries + 1 sweep restart = SENTINEL).
    assert.equal(callCount, 6);
    assert.equal(sleepCallCount, 5);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — chain with single config (no failover target)
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — single-config chain', () => {
  it('succeeds after 2 transient failures on a single-config chain', async () => {
    const chain = [cfg('solo')];
    const log = [];
    const stub = makeStub({ solo: 2 }, log); // fails twice, third succeeds
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'solo');
    assert.equal(result.attempts, 3);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// produceReview — configUsed is always the config that succeeded
// ────────────────────────────────────────────────────────────────────────────

describe('produceReview — configUsed', () => {
  it('configUsed is chain[0] on first-attempt success', async () => {
    const chain = [cfg('alpha'), cfg('beta')];
    const result = await produceReview(chain, () => 'p', {}, makeStub(), NO_SLEEP);
    assert.equal(result.configUsed.name, 'alpha');
  });

  it('configUsed is last config in chain when first two exhaust', async () => {
    const chain = [cfg('x'), cfg('y'), cfg('z')];
    // x exhausts 3 retries, y exhausts 3 retries, z succeeds
    const log = [];
    const stub = makeStub({ x: 3, y: 3 }, log);
    const result = await produceReview(chain, () => 'p', {}, stub, NO_SLEEP);
    assert.equal(result.configUsed.name, 'z');
    assert.equal(result.attempts, 7); // 3+3+1
  });
});

// ── the wall-clock deadline clamps spawn-level retry sleeps (zai-timing-sn1 review round) ─────────
// An uncapped server Retry-After near the deadline must not sleep the run past its own budget and
// into the workflow's timeout-minutes kill — the exact empty-handed cancel the budget prevents.
describe('retryTransientSpawn — deadline-clamped sleeps', () => {
  it('a Retry-After far larger than the remaining budget sleeps only the remainder', async () => {
    const slept = [];
    let calls = 0;
    await retryTransientSpawn(
      async () => {
        calls++;
        if (calls === 1) throw new TransientError('rate-limited', 120_000); // server says 2 minutes
        return 'ok';
      },
      { sleepFn: async ms => { slept.push(ms); }, deadline: 5_000, now: () => 0 }, // 5s remain
    );
    assert.deepEqual(slept, [5_000]);
  });

  it('no deadline leaves the sleep at the full Retry-After (byte-identical to before)', async () => {
    const slept = [];
    let calls = 0;
    await retryTransientSpawn(
      async () => {
        calls++;
        if (calls === 1) throw new TransientError('rate-limited', 120_000);
        return 'ok';
      },
      { sleepFn: async ms => { slept.push(ms); } },
    );
    assert.deepEqual(slept, [120_000]);
  });

  it('a deadline already past clamps the sleep to zero (the next attempt is refused at the spawn gate, not slept toward)', async () => {
    const slept = [];
    let calls = 0;
    await retryTransientSpawn(
      async () => {
        calls++;
        if (calls === 1) throw new TransientError('rate-limited', 120_000);
        return 'ok';
      },
      { sleepFn: async ms => { slept.push(ms); }, deadline: 0, now: () => 10 },
    );
    assert.deepEqual(slept, [0]);
  });
});

// ── produceReview measures its budget on the injected clock (zai-timing-sn1 review round 2) ───────
// The `now` seam exists for deterministic deadline tests: the budget must be SPENT on the same
// clock it was measured on, never on ambient wall time.
describe('produceReview — injected clock', () => {
  it('a fake clock that advances past the budget between attempts ends the run instead of sleeping on', async () => {
    let clock = 0;
    const slept = [];
    let attempts = 0;
    await assert.rejects(
      produceReview(
        [cfg('only')],
        null, null,
        async () => {
          attempts++;
          clock += 10_000; // each attempt burns 10s of fake time; the 5s budget is gone after one
          throw new TransientError('rate-limited');
        },
        async ms => { slept.push(ms); },
        5_000,
        () => clock,
      ),
      /rate-limited/,
    );
    assert.equal(attempts, 1); // budgetLeft hit 0 on the fake clock — no second attempt, no sleep
    assert.deepEqual(slept, []);
  });
});

// ── round 5: the clamp binds the BACKOFF branch too, not only Retry-After ─────────────────────────
describe('retryTransientSpawn — backoff branch clamped by the deadline', () => {
  it('with no Retry-After, the exponential backoff is clamped to the remaining budget', async () => {
    const slept = [];
    let calls = 0;
    await retryTransientSpawn(
      async () => {
        calls++;
        if (calls === 1) throw new TransientError('connection error'); // retryAfterMs null → backoff
        return 'ok';
      },
      // attempt-1 backoff is jittered in [1000, 2000); a 500ms remainder is below its floor, so the
      // recorded sleep proves the clamp bound the backoff branch — deterministic despite the jitter.
      { sleepFn: async ms => { slept.push(ms); }, deadline: 500, now: () => 0 },
    );
    assert.deepEqual(slept, [500]);
  });
});

// ── the chain-sweep circuit breaker ───────────────────────────────────────────────────────────────
// A spent Claude subscription answers every spawn in ~500ms with `"error":"rate_limit"` — the same
// words as a 429 of backpressure, so it is classified transient and always will be. What must not
// follow is an unbounded retry: run 32641456876 spent the whole 25-minute budget on 138 such spawns
// and then reported the deadline, not the quota, as the cause. These tests pin the contract that
// makes both impossible — the ladder ends by COUNT, and it ends carrying the provider's own words.
describe('produceReview — the chain-sweep circuit breaker', () => {
  // produceReview's own per-config attempt policy (1 initial + 2 retries).
  const PER_CONFIG_LIMIT = 3;
  const wall = () => new TransientError("rate-limited: You've hit your limit · resets 1pm (UTC)");

  // The clock NEVER advances here, so the budget can never expire. Anything that ends the run is
  // therefore the breaker and nothing else — the distinction the 25-minute failure blurred.
  const frozenClock = () => 0;
  const GENEROUS_BUDGET_MS = 25 * 60 * 1000;

  for (const chain of [[cfg('only')], [cfg('a'), cfg('b')]]) {
    it(`a wall that never clears ends after a counted number of attempts (${chain.length}-config chain)`, async () => {
      let attempts = 0;
      const produceOnce = async () => { attempts++; throw wall(); };

      await assert.rejects(
        () => produceReview(chain, null, null, produceOnce, NO_SLEEP, GENEROUS_BUDGET_MS, frozenClock),
        // [LAW:no-silent-failure] The provider's own last word survives as the run's reported cause,
        // rather than being overwritten by whatever bound happened to fire last.
        err => err instanceof TransientError && /hit your limit/.test(err.message),
      );

      assert.equal(attempts, PER_CONFIG_LIMIT * chain.length * MAX_CHAIN_SWEEPS);
    });
  }

  // The breaker must bound futile retrying WITHOUT cutting off a provider that recovers inside the
  // bound — otherwise it would trade a 25-minute burn for a review lost to one long blip.
  it('still returns a review when the provider clears on the very last allowed attempt', async () => {
    const chain = [cfg('only')];
    const budgetedAttempts = PER_CONFIG_LIMIT * chain.length * MAX_CHAIN_SWEEPS;
    let attempts = 0;
    const produceOnce = async () => {
      attempts++;
      if (attempts < budgetedAttempts) throw wall();
      return FAKE_REVIEW;
    };

    const { review, attempts: reported } = await produceReview(
      chain, null, null, produceOnce, NO_SLEEP, GENEROUS_BUDGET_MS, frozenClock,
    );
    assert.equal(review, FAKE_REVIEW);
    assert.equal(reported, budgetedAttempts);
  });
});
