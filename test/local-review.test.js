'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSession } = require('../scripts/session-stats');
const { parseArgs, formatReport } = require('../scripts/local-review');

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
  assert.equal(parseArgs(['--base-url=http://x']).baseUrl, 'http://x');
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
    /--base-url does not apply to --provider claude-subscription/,
  );
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
      usage: { inputTokens: 1000, outputTokens: 200, cost: { available: true, usd: 0.0123 } },
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
  assert.match(report, /\$0\.0123 est\./);
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
    result: { findings: [], summary: 'clean', usage: null },
    sessions: [],
  });
  assert.match(report, /endpoint: oauth \(subscription\) → https:\/\/api\.anthropic\.com/);
  assert.match(report, /billed to plan quota, not per token/);
});
