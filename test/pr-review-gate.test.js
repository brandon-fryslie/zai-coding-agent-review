'use strict';

// ── The pre-spawn gate: which pull requests get an engine, and which get a review with no engine ──
//
// zai-coverage-bxa lived exactly here, in glue no unit test could see. Every seam downstream was
// already correct in isolation — buildReviewInput hands a patchless file to the worker as a
// read-in-full target, an off-grid finding partitions as unanchored, and an unanchored finding still
// forces REQUEST_CHANGES — yet runPrReview filtered the changed set on `f.patch` before any of them
// ran, and posted a clean APPROVE on a pull request nothing had opened. Two definitions of
// "reviewable" in two files, the stricter one first. [LAW:single-enforcer]
//
// So these assertions are about what the ORCHESTRATOR does, and they substitute only the run's
// outermost collaborators — the host API, the provider probe, and the engine layer — letting every
// seam between them run for real (transport selection, EXCLUDE_PATTERNS, material construction,
// prompt building, finding partition, review submission). The substitution is by module export and
// must happen BEFORE src/run.js is required: run.js destructures its collaborators at require time,
// so a later assignment would never be seen. node:test gives each file its own process, so the
// patched modules never leak into another suite.

// Read at require time by @actions/github (context.repo) and src/run.js (REVIEWED_REPO_ROOT).
process.env.GITHUB_REPOSITORY = 'acme/widget';
process.env.GITHUB_WORKSPACE = '/home/runner/work/widget/widget';
// core.getInput reads INPUT_*; every unset input is '' and takes its own off-value, so the budget
// gradient, difficulty scaling, dependency diff and config file are all off — simple mode.
Object.assign(process.env, {
  INPUT_PROVIDER: 'zai',
  INPUT_ZAI_API_KEY: 'test-key',
  INPUT_GITHUB_TOKEN: 'gh-token',
  // A token that CAN approve. Without it every clean review posts COMMENT, which would make each
  // "approval is withheld" assertion below pass for the wrong reason.
  INPUT_GITHUB_REVIEW_TOKEN: 'gh-review-token',
  INPUT_PR_NUMBER: '7',
  INPUT_HEAD_SHA: 'head-sha',
  INPUT_MAX_DIFF_CHARS: '0',
});

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const core = require('@actions/core');
const github = require('@actions/github');
const preflightModule = require('../src/preflight');
const multiscope = require('../src/multiscope');
const { defaultEffortProfile } = require('../src/effort');

const TOOL_NAMES = { requestChange: 'request_change', finishReview: 'finish_review' };

// The run's state for one test: what the host returns, what the engine found, what got posted.
let host;
let engineSpawns;
let engineFindings;
// What the run reported as fatal, if anything — the observable that separates "reviewed and found
// nothing" from "could not review at all", which is the whole point of the identity gate failing loud.
let failures;

// A pull request nobody has reviewed yet, from a branch on the base repo (not a fork).
//
// The fake is built FROM THE TOKEN, because which account a run acts as is the thing the identity gate
// turns on: a fake that discarded its token could not tell a run that threaded both credentials from one
// that dropped either. Every token behaves as an installation by default, so each test below is
// byte-identical to before this parameter existed; `host.patTokens` is what opts one token into the PAT
// arm, and only the multi-credential test sets it.
function fakeOctokit(tokenValue) {
  const isPat = host.patTokens.has(tokenValue);
  // A credential that can answer NEITHER arm: /user refuses it and the installation probe refuses it too
  // — a revoked PAT, an SSO-gated one, a secondary rate limit. Identity is then unresolvable, and the
  // design's whole claim is that this reds the run rather than guessing in either direction.
  const identityBroken = host.brokenIdentityTokens.has(tokenValue);
  return {
    rest: {
      // The default GITHUB_TOKEN an unconfigured consumer runs on: an installation token, which refuses
      // GET /user with 403 'Resource not accessible by integration' and answers the installation probe
      // below (measured in a real Actions job, 2026-08-24). So these run()-level tests exercise the bot
      // arm of resolveReviewerIdentity — the arm production reaches by default — rather than a PAT path
      // most consumers never take.
      users: {
        getAuthenticated: async () => {
          if (identityBroken) {
            const e = new Error('Bad credentials');
            e.status = 403;
            throw e;
          }
          if (isPat) return { data: { login: `${tokenValue}-account`, type: 'User' } };
          const e = new Error('Resource not accessible by integration');
          e.status = 403;
          throw e;
        },
      },
      pulls: {
        get: async () => ({ data: { number: 7, labels: [], body: '', user: { login: 'author' }, base: { repo: { id: 1 } }, head: { repo: { id: 1 } } } }),
        listFiles: async () => ({ data: host.files }),
        listReviews: async () => ({ data: host.priorReviews }),
        createReview: async (args) => { host.reviews.push(args); },
      },
    },
    // Two routes reach `request`, and they must not answer for each other: the unified-diff fallback
    // selectTransport takes when no file carries an inline patch, and the probe that CONFIRMS this token
    // is an installation token. A catch-all would confirm the installation by coincidence.
    request: async (route) => {
      if (route === 'GET /installation/repositories') {
        if (identityBroken) {
          const e = new Error('Resource not accessible by personal access token');
          e.status = 403;
          throw e;
        }
        return { data: { total_count: 1 } };
      }
      return { data: host.unifiedDiff };
    },
  };
}

beforeEach(() => {
  host = {
    files: [], unifiedDiff: '', reviews: [], priorReviews: [],
    patTokens: new Set(), brokenIdentityTokens: new Set(),
  };
  engineSpawns = [];
  engineFindings = [];
  failures = [];
});

github.getOctokit = (tokenValue) => fakeOctokit(tokenValue);
core.setFailed = (m) => { failures.push(m); };
// A probe result is not what these tests are about; the chain is usable.
preflightModule.preflight = async () => ({ ok: true, results: [] });
// Stand in for the whole scout→workers pass, capturing the material it was handed so the worker
// prompt this run would have sent can be built from it — the real buildReviewInput, via the real
// buildPrMaterial, exactly as an engine would receive it.
multiscope.runMultiScope = async ({ material, chain }) => {
  engineSpawns.push(material);
  return {
    review: { summary: 'Reviewed.', findings: engineFindings, unreviewedScopes: [], assessments: [], usage: null },
    configUsed: chain[0],
  };
};

const { runPrReview } = require('../src/run');

const review = () => runPrReview('Review Agent', [], defaultEffortProfile({ roundCap: 0 }), null);
const workerPrompt = (material) => material.buildWorkerPrompt('the whole change', TOOL_NAMES, material.changedPaths, []);

describe('a pull request whose every changed file arrives without a patch', () => {
  // GitHub omits `patch` for a file whose diff is large (roughly >400 changed lines) or binary, so
  // this is an ordinary big single-file refactor — the case where being reviewed matters most.
  const patchless = [
    { filename: 'src/engine.js', status: 'modified' },
    { filename: 'assets/logo.png', status: 'added' },
  ];

  test('spawns the engine — it is not approved unread', async () => {
    host.files = patchless;
    await review();
    assert.equal(engineSpawns.length, 1);
  });

  test('hands the worker every patchless file as a read-in-full target at its absolute path', async () => {
    host.files = patchless;
    await review();
    const prompt = workerPrompt(engineSpawns[0]);
    assert.match(prompt, /could not be shown \(too large or binary/);
    assert.match(prompt, /\/home\/runner\/work\/widget\/widget\/src\/engine\.js/);
    assert.match(prompt, /\/home\/runner\/work\/widget\/widget\/assets\/logo\.png/);
    // No diff was shown, so nothing is on the LINE grid — the worker cites real file line numbers.
    assert.doesNotMatch(prompt, /```diff/);
  });

  test('a finding in a patchless file blocks the merge, rendered outside the reviewed diff', async () => {
    host.files = patchless;
    // No patch means no anchors, so this lands as unanchored — and an unanchored finding still counts.
    engineFindings = [{ path: 'src/engine.js', line: 412, body: 'unchecked index', severity: 2 }];
    await review();
    const posted = host.reviews[0];
    assert.equal(posted.event, 'REQUEST_CHANGES');
    assert.match(posted.body, /Findings outside the reviewed diff/);
    assert.match(posted.body, /unchecked index/);
    assert.equal(posted.comments, undefined); // nothing anchorable, so no inline comment
  });

  test('EXCLUDE_PATTERNS still applies — an excluded patchless file never reaches the engine', async () => {
    host.files = patchless;
    await runPrReview('Review Agent', ['assets/**'], defaultEffortProfile({ roundCap: 0 }), null);
    assert.deepEqual(engineSpawns[0].changedPaths, ['src/engine.js']);
  });
});

describe('a pull request with no reviewable changed file', () => {
  test('an empty changed set posts a review and spawns no engine', async () => {
    host.files = [];
    await review();
    assert.equal(engineSpawns.length, 0);
    assert.equal(host.reviews.length, 1);
    assert.match(host.reviews[0].body, /changed no reviewable files/);
  });

  test('EXCLUDE_PATTERNS matching every changed file spawns no engine', async () => {
    host.files = [{ filename: 'dist/index.js', status: 'modified', patch: '@@ -1 +1 @@\n+x' }];
    await runPrReview('Review Agent', ['dist/**'], defaultEffortProfile({ roundCap: 0 }), null);
    assert.equal(engineSpawns.length, 0);
    assert.equal(host.reviews.length, 1);
  });

  // [LAW:no-silent-failure] "every changed file was refused at the diff boundary" arrives here looking
  // exactly like "the pull request is empty". It must never be approved: the refusal rides to the sink
  // as review.unreviewableFiles, is listed under "Changed files NOT reviewed", and withholds approval.
  test('a changed file refused at the diff boundary is named, and approval is withheld', async () => {
    host.files = [{ filename: 'src/a\nEVIL.js', status: 'modified' }];
    await review();
    assert.equal(engineSpawns.length, 0);
    const posted = host.reviews[0];
    assert.notEqual(posted.event, 'APPROVE');
    assert.match(posted.body, /Changed files NOT reviewed/);
  });
});

describe('a pull request whose diffs are shown inline (unchanged behavior)', () => {
  test('spawns the engine and anchors a finding to the diff line', async () => {
    host.files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;' }];
    engineFindings = [{ path: 'src/a.js', line: 2, body: 'shadowed name', severity: 3 }];
    await review();
    assert.equal(engineSpawns.length, 1);
    const posted = host.reviews[0];
    assert.equal(posted.event, 'REQUEST_CHANGES');
    assert.equal(posted.comments.length, 1);
    assert.equal(posted.comments[0].line, 2);
  });

  test('a clean review of a shown diff still approves', async () => {
    host.files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' }];
    await review();
    assert.equal(host.reviews[0].event, 'APPROVE');
  });
});

// ── Both credentials reach the identity gate ──
//
// zai-review-trust-6yp gates every marker on its author, which makes "which accounts are us" a
// correctness input to the round cap, the cost totals, and which block may be dismissed. An operator who
// adds GITHUB_REVIEW_TOKEN mid-PR changes the posting account, and the rounds already on that PR were
// posted by the OTHER one. Resolving only the poster disowns them: the count resets to zero, the cap
// stops binding, and an outstanding block falls outside the set releaseUnrevisitableBlocks can release —
// the deadlock this line of work exists to close, reintroduced by a credential change alone.
//
// The unit tests cover resolveReviewerIdentities and summarizePriorReviews in isolation, and the
// multi-identity case by handing summarizePriorReviews an identities array built by hand. What none of
// them can see is whether run.js resolves and passes the RIGHT tokens — which is glue, and therefore
// exactly the class of bug this file was opened for.
describe('a run holding both GITHUB_TOKEN and GITHUB_REVIEW_TOKEN', () => {
  const REVIEW_MARKER = '<!-- copirate-code-review-agent -->';
  // The prior round: posted by the installation token, back before GITHUB_REVIEW_TOKEN was configured.
  const roundByInstallationToken = {
    id: 11,
    state: 'COMMENTED',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `an earlier round\n\n${REVIEW_MARKER}`,
  };
  // A cap of 1 makes the count observable as behavior rather than as an internal: one prior round of ours
  // is the cap, so the engine must not spawn. [LAW:behavior-not-structure]
  const reviewCappedAtOne = () => runPrReview('Review Agent', [], defaultEffortProfile({ roundCap: 1 }), null);

  beforeEach(() => {
    // GITHUB_REVIEW_TOKEN as consumers are told to set it: a user PAT, which names itself on GET /user
    // and so resolves to the login arm — a DIFFERENT identity from the installation token's bot arm.
    host.patTokens = new Set(['gh-review-token']);
    host.files = [{ filename: 'src/a.js', status: 'modified', patch: '@@ -1,1 +1,1 @@\n+const a = 1;' }];
    host.priorReviews = [roundByInstallationToken];
  });

  // There is deliberately NO "a client was built from each credential" test here. Both tokens reach
  // getOctokit at the top of runPrReview — for the reading client and the posting client — on every run
  // in this file, so such an assertion holds with the identity wiring deleted: a test that cannot fail,
  // which is worse than no test because it reads as coverage. The behavior worth guarding is the one
  // below, and it is guarded by its consequence. [LAW:behavior-not-structure]
  test('a round posted under the other credential is still counted as ours', async () => {
    await reviewCappedAtOne();
    // If only the posting PAT's identity were resolved, the bot-authored round would read as a stranger's,
    // the count would be 0, the cap would not bind, and an engine would spawn on an already-capped PR.
    assert.equal(engineSpawns.length, 0, 'the prior round was disowned: the cap did not bind');
    assert.equal(host.reviews.length, 1);
    assert.match(host.reviews[0].body, /not-reviewed:round-cap/);
  });

  // The gate's own failure arm, through the orchestrator. resolveReviewerIdentity throwing is not a
  // degraded mode this run can continue in: with no identity, the round count and the cost totals are
  // both unattributable, and every direction out is a lie — trusting all bodies restores the forgery,
  // trusting none zeroes a spend cap. So the run must red WITHOUT spending an engine spawn and WITHOUT
  // posting anything to the PR, since a posted artifact would itself become unattributable history.
  test('an unresolvable credential reds the run before any spend, and says nothing at the PR', async () => {
    host.patTokens = new Set();
    host.brokenIdentityTokens = new Set(['gh-review-token']);
    host.priorReviews = [];
    await reviewCappedAtOne();
    assert.equal(engineSpawns.length, 0, 'an engine was spawned on a run that cannot attribute its own reviews');
    assert.equal(host.reviews.length, 0, 'a review was posted by a run with no resolvable identity');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /identity|Bad credentials|attributed/i);
  });
});
