'use strict';
const core = require('@actions/core');
const { COLLECTOR_SERVER_ARG } = require('./collector');
const { runReviewCollectorServer } = require('./collector-server');
const { run } = require('./run');

if (process.argv.includes(COLLECTOR_SERVER_ARG)) {
  runReviewCollectorServer();
} else if (require.main === module) {
  run().catch(err => core.setFailed(err.message));
}

// Re-exports for test imports — all symbols the T1 test suite requires from this path.
const { patchLines, parseUnifiedDiff, buildReviewAnchors, annotatePatchWithLines, unquoteCStylePath, parseGitDiffHeader } = require('./diff');
const { gitHubTransport, giteaTransport, resolveReviewTarget, prIsFromFork, summarizePriorReviews, resolveReviewerIdentity, isOwnArtifact, fetchPriorPushbacks, pairPushbacks, roundCapReached, parseMaxRounds, isOutstandingBlock, REVIEW_MARKER } = require('./transport');
const { TransientError, parseRetryAfterMs, transientBackoffMs } = require('./failover');
const { classifyClaudeError } = require('./engine/claude-code');
const { LEDGER_MARKER, ledgerEntryBody, sumCostToday, readSpentToday, appendCost } = require('./ledger');

module.exports = {
  patchLines,
  parseUnifiedDiff,
  buildReviewAnchors,
  annotatePatchWithLines,
  unquoteCStylePath,
  parseGitDiffHeader,
  gitHubTransport,
  giteaTransport,
  resolveReviewTarget,
  prIsFromFork,
  summarizePriorReviews,
  resolveReviewerIdentity,
  isOwnArtifact,
  fetchPriorPushbacks,
  pairPushbacks,
  roundCapReached,
  parseMaxRounds,
  isOutstandingBlock,
  REVIEW_MARKER,
  TransientError,
  classifyClaudeError,
  parseRetryAfterMs,
  transientBackoffMs,
  LEDGER_MARKER,
  ledgerEntryBody,
  sumCostToday,
  readSpentToday,
  appendCost,
};
