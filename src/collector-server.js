'use strict';
const fs = require('fs');
const { parseFindingValue, parseScopeValue, parseAssessmentValue } = require('./review');

function writeJsonRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeJsonRpcError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function appendCollectorRecord(record) {
  const recordsPath = process.env.REVIEW_COLLECTOR_RECORDS;
  if (!recordsPath) {
    throw new Error('REVIEW_COLLECTOR_RECORDS is required.');
  }
  fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function collectorTools() {
  return [
    {
      name: 'request_change',
      description: "Record a code issue anchored to a visible diff line. Every recorded issue must change before merge — recording one requests changes on the review. Record EVERY genuine issue you find, including one you are only moderately sure of (state what you are unsure of in the body). Do not use for praise, neutral observations, or pure style/naming preferences.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          line: { type: 'integer' },
          body: { type: 'string' },
        },
        required: ['path', 'line', 'body'],
        additionalProperties: false,
      },
    },
    {
      name: 'add_scope',
      description: "Record one review scope while PLANNING a review: a single concern to review and the exact files/aspect to examine in it. When reviewing a pull request, list that scope's changed files in 'files' — every changed file must be assigned to exactly one scope, and its worker reads those files in full. Call once per scope. Do not use while reviewing code (use request_change for findings).",
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          focus: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'focus'],
        additionalProperties: false,
      },
    },
    {
      name: 'assess_dependency',
      description: "Record your merge-risk judgment of ONE resolved dependency-version bump (a go.mod requirement whose upstream change context was fetched for you). Call once per bumped module you were asked to assess. The host already owns the module name, version jump, and the compare/commit/release links — provide ONLY your judgment: 'impact' is one line synthesizing what materially changed upstream (not a commit dump); 'affected' is whether THIS repo's own usage breaks or changes; 'callSite' names the file (or file:line) when affected; 'verdict' is 'safe' (routine, merge freely), 'review' (worth a human glance), or 'risky' (breaking change that touches this repo — do not merge without addressing).",
      inputSchema: {
        type: 'object',
        properties: {
          module: { type: 'string' },
          impact: { type: 'string' },
          affected: { type: 'boolean' },
          callSite: { type: 'string' },
          verdict: { type: 'string', enum: ['safe', 'review', 'risky'] },
        },
        required: ['module', 'impact', 'affected', 'verdict'],
        additionalProperties: false,
      },
    },
    {
      name: 'finish_review',
      description: 'Finish the review after all required changes have been requested.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  ];
}

function callCollectorTool(name, args) {
  if (name === 'request_change') {
    const finding = parseFindingValue(args, 0);
    appendCollectorRecord({ type: 'request_change', finding });
    return { content: [{ type: 'text', text: 'Required change recorded.' }] };
  }
  if (name === 'add_scope') {
    const scope = parseScopeValue(args, 0);
    appendCollectorRecord({ type: 'scope', scope });
    return { content: [{ type: 'text', text: 'Review scope recorded.' }] };
  }
  if (name === 'assess_dependency') {
    const assessment = parseAssessmentValue(args, 0);
    appendCollectorRecord({ type: 'assessment', assessment });
    return { content: [{ type: 'text', text: 'Dependency assessment recorded.' }] };
  }
  if (name === 'finish_review') {
    if (!args || typeof args.summary !== 'string' || args.summary.trim().length === 0) {
      throw new Error('finish_review requires a non-empty summary.');
    }
    appendCollectorRecord({ type: 'finish', summary: args.summary.trim() });
    return { content: [{ type: 'text', text: 'Review finished.' }] };
  }
  throw new Error(`Unknown review collector tool: ${name}`);
}

function handleCollectorMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (message.id === undefined) {
    return;
  }

  try {
    if (message.method === 'initialize') {
      writeJsonRpcResponse(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'zai-review-collector', version: '0.1.0' },
      });
    } else if (message.method === 'tools/list') {
      writeJsonRpcResponse(message.id, { tools: collectorTools() });
    } else if (message.method === 'tools/call') {
      const result = callCollectorTool(message.params?.name, message.params?.arguments || {});
      writeJsonRpcResponse(message.id, result);
    } else {
      writeJsonRpcError(message.id, -32601, `Unknown method: ${message.method}`);
    }
  } catch (err) {
    writeJsonRpcError(message.id, -32000, err.message);
  }
}

function runReviewCollectorServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const message = JSON.parse(line);
        const messages = Array.isArray(message) ? message : [message];
        for (const item of messages) {
          handleCollectorMessage(item);
        }
      } catch {
        writeJsonRpcError(null, -32700, 'Invalid JSON-RPC message.');
      }
    }
  });
}

module.exports = { runReviewCollectorServer };
