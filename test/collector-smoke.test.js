'use strict';
// Smoke test: spawn dist/index.js as the MCP collector server and perform a
// full initialize → tools/list → request_change → finish_review handshake.
// This machine-checks the self-respawn invariant (__filename → dist/index.js
// after ncc bundling) and the collector contract every time CI runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'index.js');

// Send one JSON-RPC message and await the next response line from the process.
// [LAW:no-ambient-temporal-coupling] each step is gated on the prior response;
// ordering is explicit in the request/response pairs, not in timing assumptions.
// [LAW:no-silent-failure] child 'close' rejects the promise so a crashed server
// surfaces an error immediately rather than hanging the test indefinitely.
function rpc(child, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

    let buffer = '';
    const cleanup = () => {
      child.stdout.removeListener('data', onData);
      child.removeListener('close', onClose);
    };
    const onData = chunk => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`Non-JSON response: ${line}`));
      }
    };
    const onClose = code => {
      cleanup();
      reject(new Error(`Child exited with code ${code} before responding to ${method}`));
    };

    child.stdout.on('data', onData);
    child.once('close', onClose);
    child.stdin.write(`${msg}\n`);
  });
}

test('collector smoke: full MCP handshake produces valid records.jsonl', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-smoke-'));
  const recordsPath = path.join(tmpDir, 'records.jsonl');

  const child = spawn(process.execPath, [DIST, '--review-collector-server'], {
    env: { ...process.env, REVIEW_COLLECTOR_RECORDS: recordsPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    // 1. initialize
    const initResp = await rpc(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.1' },
    });
    assert.equal(initResp.id, 1);
    assert.ok(initResp.result, 'initialize must return a result');
    assert.ok(initResp.result.serverInfo, 'initialize result must include serverInfo');

    // 2. tools/list
    const listResp = await rpc(child, 2, 'tools/list', {});
    assert.equal(listResp.id, 2);
    const tools = listResp.result.tools;
    assert.ok(Array.isArray(tools));
    const toolNames = tools.map(t => t.name);
    assert.ok(toolNames.includes('request_change'), 'tools must include request_change');
    assert.ok(toolNames.includes('finish_review'), 'tools must include finish_review');
    assert.ok(toolNames.includes('add_scope'), 'tools must include add_scope');
    assert.ok(toolNames.includes('assess_dependency'), 'tools must include assess_dependency');

    // 3. tools/call request_change
    const changeResp = await rpc(child, 3, 'tools/call', {
      name: 'request_change',
      arguments: { path: 'src/foo.js', line: 10, body: 'Fix this invariant.', severity: 4 },
    });
    assert.equal(changeResp.id, 3);
    assert.ok(changeResp.result, 'request_change must return a result');
    assert.ok(!changeResp.error, `request_change must not error: ${JSON.stringify(changeResp.error)}`);

    // 4. tools/call finish_review
    const finishResp = await rpc(child, 4, 'tools/call', {
      name: 'finish_review',
      arguments: { summary: 'One required change.' },
    });
    assert.equal(finishResp.id, 4);
    assert.ok(finishResp.result, 'finish_review must return a result');
    assert.ok(!finishResp.error, `finish_review must not error: ${JSON.stringify(finishResp.error)}`);

    // 5. Assert records.jsonl contents
    assert.ok(fs.existsSync(recordsPath), 'records.jsonl must have been created');
    const lines = fs.readFileSync(recordsPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'must have exactly two records (one request_change + one finish)');

    const changeRecord = JSON.parse(lines[0]);
    assert.equal(changeRecord.type, 'request_change');
    assert.deepEqual(changeRecord.finding, { path: 'src/foo.js', line: 10, body: 'Fix this invariant.', severity: 4 });

    const finishRecord = JSON.parse(lines[1]);
    assert.equal(finishRecord.type, 'finish');
    assert.equal(finishRecord.summary, 'One required change.');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('collector smoke: a scout records scopes via add_scope and readCollectedReview returns them typed', async () => {
  const { readCollectedReview } = require('../src/collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-smoke-'));
  const recordsPath = path.join(tmpDir, 'records.jsonl');

  const child = spawn(process.execPath, [DIST, '--review-collector-server'], {
    env: { ...process.env, REVIEW_COLLECTOR_RECORDS: recordsPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await rpc(child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } });

    // A scout planning a review: two add_scope calls, then finish_review with structural prose. The
    // first assigns its changed files (PR mode); the second omits files (verifying the [] default).
    const s1 = await rpc(child, 2, 'tools/call', { name: 'add_scope', arguments: { name: 'cost', focus: 'the price table', files: ['src/usage.js', 'src/report.js'] } });
    assert.ok(!s1.error, `add_scope must not error: ${JSON.stringify(s1.error)}`);
    await rpc(child, 3, 'tools/call', { name: 'add_scope', arguments: { name: 'run→transport', focus: 'the run→transport boundary' } });
    await rpc(child, 4, 'tools/call', { name: 'finish_review', arguments: { summary: 'A code-review GitHub Action.' } });

    // readCollectedReview returns scopes as typed records, findings empty — never parsed from prose.
    const review = readCollectedReview(recordsPath);
    assert.deepEqual(review.findings, []);
    assert.equal(review.scopes.length, 2);
    assert.deepEqual(review.scopes[0], { name: 'cost', focus: 'the price table', files: ['src/usage.js', 'src/report.js'] });
    assert.equal(review.scopes[1].name, 'run→transport');
    assert.equal(review.scopes[1].focus, 'the run→transport boundary');
    assert.deepEqual(review.scopes[1].files, []); // files omitted → clean empty assignment
    assert.equal(review.summary, 'A code-review GitHub Action.');
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('collector smoke: a worker records a dependency assessment and readCollectedReview returns it typed', async () => {
  const { readCollectedReview } = require('../src/collector');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-smoke-'));
  const recordsPath = path.join(tmpDir, 'records.jsonl');

  const child = spawn(process.execPath, [DIST, '--review-collector-server'], {
    env: { ...process.env, REVIEW_COLLECTOR_RECORDS: recordsPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await rpc(child, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } });

    // A go.mod-owning worker: one assessment, then finish. callSite omitted (not affected) → null default.
    const a = await rpc(child, 2, 'tools/call', {
      name: 'assess_dependency',
      arguments: { module: 'github.com/gorilla/mux', impact: 'adds context helpers', affected: false, verdict: 'safe' },
    });
    assert.ok(!a.error, `assess_dependency must not error: ${JSON.stringify(a.error)}`);
    await rpc(child, 3, 'tools/call', { name: 'finish_review', arguments: { summary: 'One safe dependency bump.' } });

    const review = readCollectedReview(recordsPath);
    assert.deepEqual(review.findings, []);
    assert.equal(review.assessments.length, 1);
    assert.deepEqual(review.assessments[0], { module: 'github.com/gorilla/mux', impact: 'adds context helpers', affected: false, callSite: null, verdict: 'safe' });
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true });
  }
});

test('collector smoke: unknown method returns JSON-RPC error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-smoke-'));
  const recordsPath = path.join(tmpDir, 'records.jsonl');

  const child = spawn(process.execPath, [DIST, '--review-collector-server'], {
    env: { ...process.env, REVIEW_COLLECTOR_RECORDS: recordsPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    // Send initialize first so the server is ready
    await rpc(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '0.0.1' },
    });

    const errResp = await rpc(child, 99, 'nonexistent/method', {});
    assert.equal(errResp.id, 99);
    assert.ok(errResp.error, 'unknown method must return a JSON-RPC error');
    assert.equal(errResp.error.code, -32601);
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true });
  }
});
