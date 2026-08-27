'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSession } = require('../scripts/session-stats');
const { parseArgs, formatReport } = require('../scripts/local-review');
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
    },
    // Read the changed file (src/run.js) AND a sibling (src/engine/run.js): same basename, different
    // file — only the latter is beyond the diff, and repo-relative paths must keep them distinct.
    sessions: [{ file: '/tmp/t.txt', toolCounts: { Read: 2 }, exploreCalls: 2, explored: true, reads: ['/repo/src/run.js', '/repo/src/engine/run.js'], greps: [], globs: [] }],
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
    });
    assert.match(report, new RegExp(`endpoint: ${kind}[^\\n]*https://h\\.example`), `credential kind '${kind}' has no AUTH_LABEL entry`);
  }
});
