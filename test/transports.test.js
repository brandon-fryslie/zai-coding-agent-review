'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { gitHubTransport, giteaTransport, resolveReviewTarget, prIsFromFork, summarizePriorReviews, fetchPriorPushbacks, pairPushbacks, roundCapReached, parseMaxRounds, REVIEW_MARKER } = require('../src/index.js');
const { costMarker } = require('../src/usage');

describe('gitHubTransport.toComment', () => {
  test('maps finding to GitHub inline comment shape', () => {
    const transport = gitHubTransport([]);
    const comment = transport.toComment({ path: 'src/foo.js', line: 42, body: 'fix this' });
    assert.deepEqual(comment, { path: 'src/foo.js', line: 42, side: 'RIGHT', body: 'fix this' });
  });

  test('uses RIGHT side always', () => {
    const transport = gitHubTransport([]);
    const comment = transport.toComment({ path: 'a.js', line: 1, body: 'x' });
    assert.equal(comment.side, 'RIGHT');
  });

  // [LAW:verifiable-goals] AC (home-copirate-review-9uj.12): GitHub's create-review `event`
  // takes the imperative 'APPROVE'.
  test('approveEvent is GitHub\'s imperative spelling', () => {
    assert.equal(gitHubTransport([]).approveEvent, 'APPROVE');
  });
});

describe('giteaTransport.toComment', () => {
  test('maps finding to Gitea new_position comment shape', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'src/bar.js', line: 7, body: 'fix that' });
    assert.deepEqual(comment, { path: 'src/bar.js', new_position: 7, body: 'fix that' });
  });

  test('has no side field', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'f.js', line: 1, body: 'x' });
    assert.equal('side' in comment, false);
  });

  test('has no line field (uses new_position instead)', () => {
    const transport = giteaTransport([]);
    const comment = transport.toComment({ path: 'f.js', line: 5, body: 'x' });
    assert.equal('line' in comment, false);
    assert.equal(comment.new_position, 5);
  });

  // [LAW:verifiable-goals] AC (home-copirate-review-9uj.12): Gitea's ReviewStateType enum spells
  // approval 'APPROVED' (past tense) — sending GitHub's 'APPROVE' silently falls through to
  // Gitea's default ReviewTypePending branch with no error, verified live against Gitea v1.27.1.
  test('approveEvent is Gitea\'s ReviewStateType spelling, not GitHub\'s', () => {
    assert.equal(giteaTransport([]).approveEvent, 'APPROVED');
  });
});

describe('prIsFromFork', () => {
  test('same-repo branch PR (head id == base id) is not a fork', () => {
    const pr = { head: { repo: { id: 100 } }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), false);
  });

  test('cross-repo PR (head id != base id) is a fork', () => {
    const pr = { head: { repo: { id: 200 } }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('deleted fork head (head.repo null) is treated as a fork', () => {
    const pr = { head: { repo: null }, base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('missing head object entirely is treated as a fork', () => {
    const pr = { base: { repo: { id: 100 } } };
    assert.equal(prIsFromFork(pr), true);
  });

  test('missing base repo fails loud (malformed PR data, not a silent skip)', () => {
    const pr = { head: { repo: { id: 100 } }, base: {} };
    assert.throws(() => prIsFromFork(pr), /no base repository/);
  });
});

describe('roundCapReached', () => {
  test('not reached below the cap', () => {
    assert.equal(roundCapReached(4, 5), false);
  });

  test('reached exactly at the cap (yields exactly maxRounds reviews)', () => {
    assert.equal(roundCapReached(5, 5), true);
  });

  test('reached above the cap', () => {
    assert.equal(roundCapReached(6, 5), true);
  });

  test('maxRounds 0 is the unlimited sentinel — never reached', () => {
    assert.equal(roundCapReached(0, 0), false);
    assert.equal(roundCapReached(1000, 0), false);
  });

  test('negative maxRounds is treated as unlimited, never reached', () => {
    assert.equal(roundCapReached(1000, -1), false);
  });

  test('zero prior reviews under a positive cap always runs', () => {
    assert.equal(roundCapReached(0, 5), false);
  });
});

describe('parseMaxRounds', () => {
  test('a run of digits parses to that integer', () => {
    assert.equal(parseMaxRounds('5'), 5);
    assert.equal(parseMaxRounds('0'), 0);
    assert.equal(parseMaxRounds('42'), 42);
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(parseMaxRounds('  7 '), 7);
  });

  test('empty (explicitly cleared) is the unlimited sentinel 0', () => {
    assert.equal(parseMaxRounds(''), 0);
    assert.equal(parseMaxRounds('   '), 0);
  });

  test('[LAW:no-silent-failure] non-numeric input throws — never silently becomes 0/unlimited', () => {
    assert.throws(() => parseMaxRounds('five'), /non-negative integer/);
    assert.throws(() => parseMaxRounds('abc'), /got "abc"/);
  });

  test('[LAW:no-silent-failure] a partly-numeric value throws rather than parseInt-truncating to a cap the user never wrote', () => {
    assert.throws(() => parseMaxRounds('3x'), /non-negative integer/);
    assert.throws(() => parseMaxRounds('3abc'), /non-negative integer/);
  });

  test('a negative value is rejected (not a non-negative integer)', () => {
    assert.throws(() => parseMaxRounds('-1'), /non-negative integer/);
  });
});

describe('summarizePriorReviews', () => {
  // A fake octokit whose listReviews returns fixed pages; asserts the marker filter, cost sum, pagination.
  const fakeOctokit = (pages) => ({
    rest: { pulls: { listReviews: async ({ page }) => ({ data: pages[page - 1] || [] }) } },
  });
  const withCost = (usd) => `verdict\n\n${costMarker({ available: true, usd })}\n\n${REVIEW_MARKER}`;
  const unknownCost = () => `verdict\n\n${costMarker(null)}\n\n${REVIEW_MARKER}`;

  test('counts only reviews whose body ENDS with the marker (the trailing sentinel)', async () => {
    const octokit = fakeOctokit([[
      { body: `some verdict\n\n${REVIEW_MARKER}` },
      { body: 'a human review, no marker' },
      { body: `another round\n\n${REVIEW_MARKER}\n` }, // trailing whitespace tolerated
      { body: null }, // dismissed/empty review body
    ]]);
    assert.equal((await summarizePriorReviews(octokit, 'o', 'r', 1)).count, 2);
  });

  test('a human review that merely QUOTES the marker mid-body is not counted', async () => {
    const octokit = fakeOctokit([[
      { body: `I see the action posts \`${REVIEW_MARKER}\` — but here is my own comment.` },
      { body: `real round\n\n${REVIEW_MARKER}` },
    ]]);
    assert.equal((await summarizePriorReviews(octokit, 'o', 'r', 1)).count, 1);
  });

  test('sums the per-round cost markers into the PR cost total', async () => {
    const octokit = fakeOctokit([[
      { body: withCost(0.05) },
      { body: withCost(0.03) },
      { body: unknownCost() },              // counted as an unknown-cost round
      { body: 'a human review, no marker' }, // not a round, no cost
    ]]);
    const { count, cost } = await summarizePriorReviews(octokit, 'o', 'r', 1);
    assert.equal(count, 3); // three marker-bearing reviews
    assert.equal(Number(cost.usd.toFixed(2)), 0.08);
    assert.equal(cost.knownRounds, 2);
    assert.equal(cost.unknownRounds, 1);
  });

  test('a human review that QUOTES a cost marker is excluded from BOTH count and cost (one gate)', async () => {
    const octokit = fakeOctokit([[
      { body: `here is what the bot posts: ${costMarker({ available: true, usd: 999 })} — my own note` }, // no REVIEW_MARKER
      { body: withCost(0.04) },
    ]]);
    const { count, cost } = await summarizePriorReviews(octokit, 'o', 'r', 1);
    assert.equal(count, 1);                 // only the real agent round
    assert.equal(Number(cost.usd.toFixed(2)), 0.04); // the human's $999 marker is NOT summed
    assert.equal(cost.knownRounds, 1);
  });

  test('an agent round with no cost marker (pre-feature review) counts as unknown, not omitted', async () => {
    const octokit = fakeOctokit([[
      { body: `old verdict\n\n${REVIEW_MARKER}` }, // agent round, but no cost marker
      { body: withCost(0.04) },
    ]]);
    const { count, cost } = await summarizePriorReviews(octokit, 'o', 'r', 1);
    assert.equal(count, 2);
    assert.equal(cost.knownRounds, 1);
    assert.equal(cost.unknownRounds, 1); // the markerless agent round is an honest unknown
  });

  test('returns zeroes when the PR has no reviews', async () => {
    const { count, cost } = await summarizePriorReviews(fakeOctokit([[]]), 'o', 'r', 1);
    assert.equal(count, 0);
    assert.deepEqual(cost, { usd: 0, knownRounds: 0, unknownRounds: 0 });
  });

  test('exhausts pagination — a full first page forces a second fetch (count AND cost span pages)', async () => {
    const full = Array.from({ length: 100 }, () => ({ body: withCost(0.01) }));
    const octokit = fakeOctokit([full, [{ body: withCost(0.01) }, { body: 'no marker' }]]);
    const { count, cost } = await summarizePriorReviews(octokit, 'o', 'r', 1);
    assert.equal(count, 101);
    assert.equal(cost.knownRounds, 101);              // cost summed across BOTH pages, not just page 1
    assert.equal(Number(cost.usd.toFixed(2)), 1.01);  // 101 × $0.01
  });
});

describe('pairPushbacks', () => {
  // A finding is a top-level review comment (no in_reply_to_id); the author's pushback is a reply to it.
  test('pairs a top-level finding with the author reply on its thread', () => {
    const out = pairPushbacks([
      { id: 1, path: 'src/a.js', line: 10, body: 'Bug: off-by-one', in_reply_to_id: null },
      { id: 2, path: 'src/a.js', line: 10, body: 'Intentional — the loop is exclusive.', in_reply_to_id: 1 },
    ]);
    assert.deepEqual(out, [
      { path: 'src/a.js', line: 10, finding: 'Bug: off-by-one', replies: ['Intentional — the loop is exclusive.'] },
    ]);
  });

  // [LAW:no-silent-failure] A finding with no reply is NOT returned — there is no rebuttal to weigh, and
  // replaying it would be noise. This is the has-reply filter that keeps rounds dense, not the whole set.
  test('drops a finding that received no reply', () => {
    const out = pairPushbacks([
      { id: 1, path: 'src/a.js', line: 10, body: 'unanswered finding', in_reply_to_id: null },
    ]);
    assert.deepEqual(out, []);
  });

  // Spans rounds without any round bookkeeping: an unanswered finding from a later round is excluded while
  // an answered one from an earlier round is included — the DATA (has a reply?) decides, not a counter.
  test('includes answered findings and excludes still-unanswered ones regardless of round', () => {
    const out = pairPushbacks([
      { id: 1, path: 'a.js', line: 1, body: 'round-1 finding, rebutted', in_reply_to_id: null },
      { id: 2, path: 'a.js', line: 1, body: 'this is fine because X', in_reply_to_id: 1 },
      { id: 3, path: 'b.js', line: 5, body: 'round-2 finding, no reply yet', in_reply_to_id: null },
    ]);
    assert.deepEqual(out, [
      { path: 'a.js', line: 1, finding: 'round-1 finding, rebutted', replies: ['this is fine because X'] },
    ]);
  });

  test('collects multiple replies on one thread in order, trimming and dropping empties', () => {
    const out = pairPushbacks([
      { id: 1, path: 'a.js', line: 1, body: 'finding', in_reply_to_id: null },
      { id: 2, path: 'a.js', line: 1, body: '  first reply  ', in_reply_to_id: 1 },
      { id: 3, path: 'a.js', line: 1, body: '   ', in_reply_to_id: 1 }, // whitespace-only reply dropped
      { id: 4, path: 'a.js', line: 1, body: 'second reply', in_reply_to_id: 1 },
    ]);
    assert.deepEqual(out[0].replies, ['first reply', 'second reply']);
  });

  // Gitea may omit `line`; the pairing degrades to path-only context rather than failing (display-only).
  test('falls back to original_line, then null, when line is absent', () => {
    const out = pairPushbacks([
      { id: 1, path: 'a.js', original_line: 7, body: 'f1', in_reply_to_id: null },
      { id: 2, body: 'r1', in_reply_to_id: 1 },
      { id: 3, path: 'b.js', body: 'f2', in_reply_to_id: null },
      { id: 4, body: 'r2', in_reply_to_id: 3 },
    ]);
    assert.equal(out[0].line, 7);
    assert.equal(out[1].line, null);
  });

  test('returns empty for a PR with no review comments', () => {
    assert.deepEqual(pairPushbacks([]), []);
  });
});

describe('fetchPriorPushbacks', () => {
  const fakeOctokit = (pages) => ({
    rest: { pulls: { listReviewComments: async ({ page }) => ({ data: pages[page - 1] || [] }) } },
  });

  test('exhausts pagination before pairing — a reply on page 2 pairs a finding from page 1', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, path: 'a.js', line: i, body: `f${i}`, in_reply_to_id: null }));
    const page2 = [{ id: 500, path: 'a.js', line: 0, body: 'rebuttal', in_reply_to_id: 1 }];
    const out = await fetchPriorPushbacks(fakeOctokit([page1, page2]), 'o', 'r', 1);
    // Only finding id=1 got a reply (from page 2); the other 99 findings are unanswered and dropped.
    assert.deepEqual(out, [{ path: 'a.js', line: 0, finding: 'f0', replies: ['rebuttal'] }]);
  });
});

describe('resolveReviewTarget', () => {
  test('explicit inputs take precedence over payload', () => {
    const payload = { pull_request: { number: 1, head: { sha: 'aaa' } } };
    const result = resolveReviewTarget('99', 'bbb', payload);
    assert.equal(result.pullNumber, 99);
    assert.equal(result.headSha, 'bbb');
  });

  test('falls back to payload when inputs are empty', () => {
    const payload = { pull_request: { number: 42, head: { sha: 'deadbeef' } } };
    const result = resolveReviewTarget('', '', payload);
    assert.equal(result.pullNumber, 42);
    assert.equal(result.headSha, 'deadbeef');
  });

  test('numeric string PR_NUMBER is coerced to integer', () => {
    const result = resolveReviewTarget('17', 'sha', {});
    assert.equal(result.pullNumber, 17);
  });

  test('missing payload returns undefined for both fields', () => {
    const result = resolveReviewTarget('', '', {});
    assert.equal(result.pullNumber, undefined);
    assert.equal(result.headSha, undefined);
  });

  test('partial explicit input: only PR_NUMBER provided', () => {
    const payload = { pull_request: { number: 1, head: { sha: 'fromPayload' } } };
    const result = resolveReviewTarget('5', '', payload);
    assert.equal(result.pullNumber, 5);
    assert.equal(result.headSha, 'fromPayload');
  });
});
