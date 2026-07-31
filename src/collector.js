'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('@actions/core');
const { parseFindingValue, parseScopeValue, parseAssessmentValue, parseReviewValue } = require('./review');
// [LAW:one-way-deps] ProtocolError's home is failover.js, beside TransientError — the retry seam owns
// the vocabulary of errors a re-spawn can fix, and every thrower requires it from there (codex.js does
// the same with TransientError). readCollectedReview runs in the ACTION process (never the collector
// server), so requiring failover.js here pulls in nothing that reaches the MCP stdio subprocess.
const { ProtocolError } = require('./failover');

const COLLECTOR_SERVER_ARG = '--review-collector-server';

function createReviewCollector() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-review-collector-'));
  const recordsPath = path.join(dir, 'records.jsonl');
  const mcpConfigPath = path.join(dir, 'mcp.json');
  const mcpConfig = {
    mcpServers: {
      review_collector: {
        command: process.execPath,
        args: [__filename, COLLECTOR_SERVER_ARG],
        env: {
          REVIEW_COLLECTOR_RECORDS: recordsPath,
        },
      },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');
  return { dir, recordsPath, mcpConfigPath };
}

function readCollectedReview(recordsPath) {
  if (!fs.existsSync(recordsPath)) {
    // [LAW:no-silent-failure] No records file at all is the zero-record extreme of a protocol slip: the
    // engine terminated without ever driving the collector. Typed as ProtocolError so the retry seam
    // re-spawns it in place rather than the plain Error that killed the whole multi-scope pass.
    throw new ProtocolError('The review engine did not call the review collector tools.');
  }

  const records = fs.readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const finishes = records.filter(record => record.type === 'finish');
  // [LAW:no-silent-failure] Zero finishes is the most common weak-model slip (the model forgot the gate),
  // not a code bug — typed as ProtocolError so retryTransientSpawn re-spawns instead of discarding every
  // sibling worker's already-recorded findings. The exactly-one gate now applies ONLY to the zero case.
  if (finishes.length === 0) {
    throw new ProtocolError('The review engine did not call finish_review.');
  }
  // [LAW:dataflow-not-control-flow] Two+ finishes is not a broken review — the model recorded its verdict
  // more than once. Always take the LAST finish (its final word); for a single finish last === first, so
  // there is no branch on the count for WHICH to pick — only the warning is gated on the duplicate case.
  if (finishes.length > 1) {
    core.warning(`The review engine called finish_review ${finishes.length} times; using the last one.`);
  }
  const finish = finishes[finishes.length - 1];
  const findings = records
    .filter(record => record.type === 'request_change')
    .map((record, index) => parseFindingValue(record.finding, index));
  // [LAW:dataflow-not-control-flow] One reader, two record kinds: a worker run produces findings (no
  // scopes), a scout run produces scopes (no findings) — both flow through the same collector and the
  // same exactly-one-finish gate. Scopes are typed, schema-validated records exactly like findings,
  // never parsed from prose. [FRAMING:representation]
  const scopes = records
    .filter(record => record.type === 'scope')
    .map((record, index) => parseScopeValue(record.scope, index));
  // [LAW:dataflow-not-control-flow] A third record kind through the same one reader: a worker that reviewed
  // a resolved go.mod bump records per-module dependency assessments; every other spawn produces none, so
  // this is an empty list by construction, never a branch. Typed and schema-validated exactly like findings
  // and scopes. [FRAMING:representation]
  const assessments = records
    .filter(record => record.type === 'assessment')
    .map((record, index) => parseAssessmentValue(record.assessment, index));
  const review = parseReviewValue({
    summary: finish.summary,
    findings,
  }, 'Review collector output');
  return { ...review, scopes, assessments };
}

// [FRAMING:representation] The MCP config createReviewCollector writes self-references this file:
// `node <__filename> --review-collector-server`. In the ncc bundle __filename is dist/index.js,
// whose top-level guard starts the server. Run from SOURCE, __filename is THIS file — so it must
// honor the same arg, or the self-spawn config is a promise that holds only in the bundle and lies
// from source (a silently dead MCP server for any test or dev tool that drives the engine from src).
// [LAW:no-silent-failure] This guard makes the representation true in both contexts. It is inert when
// the module is required (require.main !== module), including inside the bundle, where index.js owns
// the entry. [LAW:single-enforcer] The server impl lives in one place (collector-server); this only
// routes the arg to it.
if (require.main === module && process.argv.includes(COLLECTOR_SERVER_ARG)) {
  require('./collector-server').runReviewCollectorServer();
}

module.exports = { COLLECTOR_SERVER_ARG, createReviewCollector, readCollectedReview };
