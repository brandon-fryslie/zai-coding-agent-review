'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSession } = require('../scripts/session-stats');
const { parseArgs, formatReport, resolveConfigChain } = require('../scripts/local-review');
const { PRESETS } = require('../src/provider');

// A claude-code stream-json transcript fragment: header line (non-JSON, skipped) + tool_use events.
const STREAM = [
  'Agent review — debug transcript',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"looking"},{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/review.js"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/repo/src/run.js"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep","input":{"pattern":"partitionFindings"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__review_collector__finish_review","input":{"summary":"done"}}]}}',
  'not json at all',
].join('\n');

test('summarizeSession counts explore tools and captures targets', () => {
  const s = summarizeSession(STREAM);
  assert.equal(s.toolCounts.Read, 2);
  assert.equal(s.toolCounts.Grep, 1);
  assert.equal(s.toolCounts.mcp__review_collector__finish_review, 1);
  assert.equal(s.exploreCalls, 3);
  assert.equal(s.explored, true);
  assert.deepEqual(s.reads, ['/repo/src/review.js', '/repo/src/run.js']);
  assert.deepEqual(s.greps, ['partitionFindings']);
});

test('summarizeSession reports a diff-only session as not explored', () => {
  const s = summarizeSession('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__review_collector__finish_review","input":{"summary":"x"}}]}}');
  assert.equal(s.explored, false);
  assert.equal(s.exploreCalls, 0);
  assert.deepEqual(s.reads, []);
});

test('summarizeSession also recognizes codex-style tool calls', () => {
  const s = summarizeSession('{"type":"function_call","name":"shell","arguments":{"command":["grep","x"]}}');
  assert.equal(s.toolCounts.shell, 1);
});

test('parseArgs applies defaults and both flag forms', () => {
  const o = parseArgs(['--provider', 'deepseek', '--mode=repo', '--scope', 'auth']);
  assert.equal(o.provider, 'deepseek');
  assert.equal(o.mode, 'repo');
  assert.equal(o.scope, 'auth');
  assert.equal(o.range, 'HEAD~1 HEAD');
  assert.equal(parseArgs([]).provider, 'auto');
  // Named against an override-capable provider: bare `--base-url` now takes the DEFAULT provider,
  // which is 'auto' → the pinned subscription, and is rejected (see the aliased-pinned test below).
  assert.equal(parseArgs(['--provider=deepseek', '--base-url=http://x']).baseUrl, 'http://x');
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs rejects bad input loudly', () => {
  assert.throws(() => parseArgs(['--mode', 'sideways']), /--mode must be/);
  assert.throws(() => parseArgs(['--nope', 'v']), /Unknown option/);
  assert.throws(() => parseArgs(['positional']), /Unexpected argument/);
  assert.throws(() => parseArgs(['--provider']), /requires a value/);
  // [LAW:no-silent-failure] The subscription provider's host is pinned, so --base-url has nothing to
  // act on. Accepting the flag and dropping it would leave the operator believing they had redirected
  // an endpoint they had not.
  assert.throws(
    () => parseArgs(['--provider', 'claude-subscription', '--base-url', 'http://x']),
    /--base-url does not apply to --provider 'claude-subscription': its endpoint is PINNED/,
  );
});

test('parseArgs keeps --config exclusive with the preset flags, and --use tied to --config', () => {
  assert.equal(parseArgs(['--config', 'a.yml', '--use', 'mine']).use, 'mine');
  assert.equal(parseArgs(['--config', 'a.yml']).use, undefined);
  // [LAW:no-silent-failure] --config and the preset flags are two sources for the same facts;
  // letting one silently win would leave the operator believing the loser took effect.
  assert.throws(() => parseArgs(['--config', 'a.yml', '--model', 'm']), /--config is mutually exclusive with --model/);
  assert.throws(() => parseArgs(['--config', 'a.yml', '--provider', 'zai']), /--config is mutually exclusive with --provider/);
  assert.throws(() => parseArgs(['--config', 'a.yml', '--base-url', 'http://x']), /--config is mutually exclusive with --base-url/);
  assert.throws(() => parseArgs(['--use', 'mine']), /--use selects a config from --config/);
});

// The default provider is 'auto', which ALIASES to a pinned provider — so the no-`--provider`
// invocation is the COMMON way to reach the pinned case, not an exotic one. A guard that matched the
// concrete name only would wave this through and silently drop the flag: the same silent failure,
// reached through the default instead of the explicit name.
test('parseArgs rejects --base-url for an aliased pinned provider, naming both names', () => {
  for (const argv of [['--base-url', 'http://x'], ['--provider', 'auto', '--base-url', 'http://x']]) {
    assert.throws(
      () => parseArgs(argv),
      /--base-url does not apply to --provider 'auto' \(→ 'claude-subscription'\): its endpoint is PINNED to https:\/\/api\.anthropic\.com/,
      `argv ${JSON.stringify(argv)} must be rejected`,
    );
  }
});

// An unknown provider is synthesizeProviderConfig's to reject, naming every valid value. parseArgs
// must not grow a second enforcer of that rule — it passes the name through untouched.
test('parseArgs leaves an unknown provider to the config synthesizer', () => {
  assert.equal(parseArgs(['--provider', 'nope', '--base-url', 'http://x']).provider, 'nope');
});

test('parseArgs still accepts --base-url for the api-key providers it applies to', () => {
  for (const provider of ['deepseek', 'zai', 'codex']) {
    const o = parseArgs(['--provider', provider, '--base-url', 'http://gw.example']);
    assert.equal(o.baseUrl, 'http://gw.example', `--base-url must work for '${provider}'`);
  }
});

test('formatReport surfaces the explore verdict, beyond-diff reads, findings, and cost', () => {
  const report = formatReport({
    config: { name: 'auto→deepseek', engine: 'claude-code', model: 'deepseek-v4-pro', endpoint: { baseUrl: 'https://x/anthropic', credential: { kind: 'api-key', value: 'k' } } },
    mode: 'pr',
    repo: '/repo',
    files: [{ filename: 'src/run.js' }],
    result: {
      findings: [{ path: 'src/run.js', line: 52, body: 'comment is a WHAT-comment' }],
      summary: 'looks fine',
      usage: { tokens: { inputCacheMiss: 1000, inputCacheHit: 0, output: 200 }, cost: { basis: 'dollars', usd: 0.0123 } },
      schedule: {
        scopeConcurrency: 2, sweepCap: 0, scopeCount: 1,
        spawns: [
          { phase: 'scout', outcome: 'completed', usage: { span: { from: '2026-08-23T12:00:00.000Z', to: '2026-08-23T12:01:00.000Z' } } },
          { phase: 'worker', scope: 'the change', pass: 0, outcome: 'completed', usage: { span: { from: '2026-08-23T12:01:00.000Z', to: '2026-08-23T12:02:00.000Z' } } },
        ],
      },
    },
    // Read the changed file (src/run.js) AND a sibling (src/engine/run.js): same basename, different
    // file — only the latter is beyond the diff, and repo-relative paths must keep them distinct.
    sessions: [{ file: '/tmp/t.txt', toolCounts: { Read: 2 }, exploreCalls: 2, explored: true, reads: ['/repo/src/run.js', '/repo/src/engine/run.js'], greps: [], globs: [] }],
    totalMs: 128000,
  });
  assert.match(report, /EXPLORED REPO: YES/);
  assert.match(report, /files read:\s+src\/run\.js, src\/engine\/run\.js/);
  assert.match(report, /beyond diff:\s+src\/engine\/run\.js/); // the sibling, not the changed file
  assert.doesNotMatch(report, /beyond diff:\s+src\/engine\/run\.js, src\/run\.js/); // changed file is NOT beyond
  assert.match(report, /src\/run\.js:52/);
  // [LAW:one-source-of-truth] The diagnostic renders through the action's OWN renderCostLine, so this
  // asserts the production format — the two cannot drift into disagreeing about what a run cost.
  assert.match(report, /Cost: \$0\.0123 · 1,000 in \(0 cached\) \/ 200 out tokens · claude-code\/deepseek-v4-pro · est\./);
  assert.match(report, /endpoint: api-key → https:\/\/x\/anthropic/);
  // [LAW:one-source-of-truth] The timing renders through the action's OWN renderTimingBreakdown, so
  // the local diagnostic and the posted footer cannot drift about where the run's time went.
  assert.match(report, /timing: Timing: 2m08s total · spawns 2m00s \(2 attempt\(s\)\) — scout 1m00s · review 1m00s/);
});

// Each credential kind gets its own label, so the report cannot reach for a field the other kind
// carries — and so a subscription run says plainly that its cost is quota, not dollars.
test('formatReport labels an oauth endpoint as subscription-billed', () => {
  const report = formatReport({
    config: {
      name: 'auto→claude-subscription',
      engine: 'claude-code',
      model: 'claude-sonnet-5',
      endpoint: {
        apiType: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        credential: { kind: 'oauth', value: 'sk-ant-oat01-x' },
      },
    },
    mode: 'pr',
    repo: '/repo',
    files: [{ filename: 'src/run.js' }],
    result: {
      findings: [],
      summary: 'clean',
      usage: { tokens: { inputCacheMiss: 1000, inputCacheHit: 0, output: 200 }, cost: { basis: 'subscription', notionalUsd: 63.59 } },
    },
    sessions: [],
    totalMs: 128000,
  });
  assert.match(report, /endpoint: oauth \(subscription\) → https:\/\/api\.anthropic\.com/);
  assert.match(report, /billed to plan quota, not per token/);
  // The local diagnostic reads the same way the posted footer will: the list price is present, and
  // labelled as not-billed rather than presented as spend.
  assert.match(report, /Not billed \(Claude subscription\) · \$63\.5900 at Anthropic list price/);
});

// [LAW:one-source-of-truth] formatReport looks a credential kind up in a label table, and PRESETS is
// the one place a kind can come from. Pinning the coverage HERE — at build time, over both static
// tables — is what makes an unmapped kind unreachable, so the lookup needs no runtime guard against a
// state CI refuses to let ship. Add a kind to PRESETS without a label and this fails, naming it.
test('formatReport renders every credential kind PRESETS can produce', () => {
  for (const kind of new Set(Object.values(PRESETS).map(p => p.credentialKind))) {
    const report = formatReport({
      config: {
        name: 'x', engine: 'claude-code', model: 'm',
        endpoint: { apiType: 'anthropic-messages', baseUrl: 'https://h.example', credential: { kind, value: 'k' } },
      },
      mode: 'pr', repo: '/repo', files: [], sessions: [],
      result: { findings: [], summary: '', usage: null },
      totalMs: 128000,
    });
    assert.match(report, new RegExp(`endpoint: ${kind}[^\\n]*https://h\\.example`), `credential kind '${kind}' has no AUTH_LABEL entry`);
  }
});

test('formatReport renders a timing render failure as the line\'s explicit gap, never an aborted report', () => {
  // [LAW:no-silent-failure] same discipline as buildReviewFooter: the cause is printed in place.
  const report = formatReport({
    config: { name: 'x', engine: 'claude-code', model: 'm', endpoint: { baseUrl: 'https://h', credential: { kind: 'api-key', value: 'k' } } },
    mode: 'pr', repo: '/repo', files: [], sessions: [],
    result: { findings: [], summary: '', usage: null },
    // totalMs missing: the renderer throws, the report survives with the gap named
  });
  assert.match(report, /timing: unavailable \(renderTimingBreakdown: totalMs must be a non-negative finite number/);
});

test('parseArgs rejects an empty value for the two-source options only', () => {
  // [LAW:parse-dont-validate] For these options an empty value (typically an unset shell var:
  // --config "$CFG") would slip past the downstream truthiness discriminator and silently select
  // the other source — rejected at the parse boundary so empty is unrepresentable inland.
  assert.throws(() => parseArgs(['--config', '']), /--config requires a non-empty value/);
  assert.throws(() => parseArgs(['--config=', '--model', 'm']), /--config requires a non-empty value/);
  assert.throws(() => parseArgs(['--diff', '']), /--diff requires a non-empty value/);
  assert.throws(() => parseArgs(['--base-url=']), /--base-url requires a non-empty value/);
  assert.throws(() => parseArgs(['--model', '']), /--model requires a non-empty value/);
  // For options whose empty value equals omitting the flag, `--flag "$UNSET_VAR"` stays legal —
  // a wrapper passing --scope "$SCOPE" unconditionally must not hard-fail when SCOPE is unset.
  assert.equal(parseArgs(['--scope', '']).scope, '');
  assert.equal(parseArgs(['--repo', '']).repo, '');
});

// --- resolveConfigChain: both sources produce the same ordered-ReviewConfig-chain shape ---

const CONFIG_FIXTURE = `
version: 1
default: primary
fallback: [primary, backup]
configs:
  primary:
    engine: claude-code
    model: glm-5.1
    endpoint: { apiType: anthropic-messages, baseUrl: "https://api.z.ai/api/anthropic", credentialEnv: LR_TEST_KEY }
  backup:
    engine: opencode
    model: openai/gpt-5.4-mini
    endpoint: { apiType: openai-chat, baseUrl: "https://api.openai.com/v1", credentialEnv: LR_TEST_KEY }
`;

function withConfigFixture(fn) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-test-'));
  const file = path.join(dir, 'review.yml');
  fs.writeFileSync(file, CONFIG_FIXTURE);
  const prev = process.env.LR_TEST_KEY;
  process.env.LR_TEST_KEY = 'test-key-abc';
  try {
    return fn(file);
  } finally {
    if (prev === undefined) delete process.env.LR_TEST_KEY; else process.env.LR_TEST_KEY = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveConfigChain loads a config file through the production loader: full chain, secrets resolved', () => {
  withConfigFixture(file => {
    const chain = resolveConfigChain({ config: file });
    assert.deepEqual(chain.map(c => c.name), ['primary', 'backup']);
    assert.equal(chain[0].engine, 'claude-code');
    assert.equal(chain[0].model, 'glm-5.1');
    assert.equal(chain[0].endpoint.baseUrl, 'https://api.z.ai/api/anthropic');
    assert.equal(chain[0].endpoint.credential.value, 'test-key-abc');
    assert.equal(chain[1].engine, 'opencode');
  });
});

test('resolveConfigChain honors --use: the selected config heads the chain', () => {
  withConfigFixture(file => {
    const chain = resolveConfigChain({ config: file, use: 'backup' });
    assert.deepEqual(chain.map(c => c.name), ['backup', 'primary']);
    assert.equal(chain[0].model, 'openai/gpt-5.4-mini');
  });
});

test('resolveConfigChain without --config synthesizes a single-entry preset chain', () => {
  const prev = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'zai-test-key';
  try {
    const chain = resolveConfigChain({ provider: 'zai' });
    assert.equal(chain.length, 1);
    assert.equal(chain[0].endpoint.credential.value, 'zai-test-key');
  } finally {
    if (prev === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = prev;
  }
});

// `resolveConfigChain` is the ONLY call site in the repo that passes `baseUrl` through
// `resolveProviderConfig` — eval/run-case.js's `resolvePinnedConfig` never does, because a replay is
// forbidden from overriding its pinned host. So the generic
// `values.baseUrl → spec.inputKeys.baseUrl → inputs[key] → endpoint.baseUrl` path had exactly one user
// and no test: the existing coverage only checks that `parseArgs` stores the string. A field-name
// mismatch in that loop would silently break the gateway override with nothing going red, and the only
// provider that would notice is one nobody replays. [LAW:no-silent-failure]
test('resolveConfigChain lands --base-url on the endpoint for a provider whose row declares one', () => {
  const before = process.env.ZAI_API_KEY;
  process.env.ZAI_API_KEY = 'test-credential';
  try {
    const chain = resolveConfigChain({ provider: 'zai', baseUrl: 'http://gw.example' });
    assert.equal(chain.length, 1);
    assert.equal(chain[0].endpoint.baseUrl, 'http://gw.example');
    // Omitting it leaves the preset's own default standing, rather than an empty host.
    assert.equal(resolveConfigChain({ provider: 'zai' })[0].endpoint.baseUrl, PRESETS.zai.defaultBaseUrl);
  } finally {
    if (before === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = before;
  }
});

// The mirror of the above, on the row that must NOT be overridable: claude-subscription declares no
// baseUrl key, so its preset's pinned host stands whatever the caller passes. That is the guarantee the
// whole pinned-preset design exists for, asserted through the same seam a real local run crosses.
// [LAW:single-enforcer]
test('resolveConfigChain cannot move the subscription off its pinned host', () => {
  const before = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-credential';
  try {
    const chain = resolveConfigChain({ provider: 'claude-subscription', baseUrl: 'http://gw.example' });
    assert.equal(chain[0].endpoint.baseUrl, PRESETS['claude-subscription'].baseUrl);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = before;
  }
});
