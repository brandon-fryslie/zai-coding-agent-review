'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { partitionFindings, nearestAnchorableLine, parseFindingValue, parseAssessmentValue, dedupeAssessments, severityTaggedBody } = require('../src/review');
const { submitReview, gitHubTransport, giteaTransport } = require('../src/transport');
const { buildReviewAnchors } = require('../src/diff');

// [LAW:verifiable-goals] AC: a finding the model anchors outside the diff never aborts the
// review. It is snapped to the nearest reviewed line when close, or surfaced in the summary
// when far — and either way still counts toward the REQUEST_CHANGES verdict.

// anchors: Map<"path:line", {path, line}> — the shape buildReviewAnchors produces.
function anchorsFor(entries) {
  return new Map(entries.map(([path, line]) => [`${path}:${line}`, { path, line }]));
}

describe('nearestAnchorableLine', () => {
  test('returns null for an empty or missing file-line list', () => {
    assert.equal(nearestAnchorableLine(10, []), null);
    assert.equal(nearestAnchorableLine(10, undefined), null);
  });

  test('returns the nearest line when within the snap window', () => {
    assert.equal(nearestAnchorableLine(79, [70, 78, 90]), 78);
  });

  test('exactly at the window edge (distance 10) snaps; one past it does not', () => {
    assert.equal(nearestAnchorableLine(80, [70]), 70); // distance 10
    assert.equal(nearestAnchorableLine(81, [70]), null); // distance 11
  });

  test('picks the closest among several candidates', () => {
    assert.equal(nearestAnchorableLine(79, [76, 84]), 76); // 3 vs 5
    assert.equal(nearestAnchorableLine(81, [76, 84]), 84); // 5 vs 3
  });
});

describe('partitionFindings', () => {
  test('a finding exactly on an anchor is kept unchanged (no body annotation)', () => {
    const anchors = anchorsFor([['a.js', 10]]);
    const { anchored, unanchored } = partitionFindings([{ path: 'a.js', line: 10, body: 'fix' }], anchors);
    assert.equal(unanchored.length, 0);
    assert.deepEqual(anchored, [{ path: 'a.js', line: 10, body: 'fix' }]);
  });

  test('a finding just outside the hunk is snapped to the nearest line and annotated', () => {
    const anchors = anchorsFor([['s.astro', 78], ['s.astro', 84]]);
    const { anchored, unanchored } = partitionFindings([{ path: 's.astro', line: 79, body: 'stale comment' }], anchors);
    assert.equal(unanchored.length, 0);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].line, 78);
    assert.match(anchored[0].body, /^stale comment/);
    assert.match(anchored[0].body, /Anchored to line 78; the review referenced line 79/);
  });

  test('a finding far from any reviewed line is surfaced as unanchored, not snapped, not dropped', () => {
    const anchors = anchorsFor([['a.js', 10]]);
    const { anchored, unanchored } = partitionFindings([{ path: 'a.js', line: 200, body: 'far' }], anchors);
    assert.equal(anchored.length, 0);
    assert.deepEqual(unanchored, [{ path: 'a.js', line: 200, body: 'far' }]);
  });

  test('a finding on a file with no reviewed lines is unanchored', () => {
    const anchors = anchorsFor([['a.js', 10]]);
    const { anchored, unanchored } = partitionFindings([{ path: 'other.js', line: 5, body: 'x' }], anchors);
    assert.equal(anchored.length, 0);
    assert.equal(unanchored.length, 1);
  });

  test('mixed batch: exact + snapped + unanchored each routed correctly', () => {
    const anchors = anchorsFor([['a.js', 10], ['a.js', 12], ['b.js', 50]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'exact' },
      { path: 'a.js', line: 14, body: 'near' },      // snaps to 12 (distance 2)
      { path: 'b.js', line: 999, body: 'far' },       // unanchored
    ];
    const { anchored, unanchored } = partitionFindings(findings, anchors);
    assert.deepEqual(anchored.map(f => [f.path, f.line]), [['a.js', 10], ['a.js', 12]]);
    assert.deepEqual(unanchored.map(f => [f.path, f.line]), [['b.js', 999]]);
  });

  test('snapping never reuses across files (same line number, different file stays unanchored)', () => {
    const anchors = anchorsFor([['a.js', 79]]);
    const { anchored, unanchored } = partitionFindings([{ path: 'b.js', line: 79, body: 'x' }], anchors);
    assert.equal(anchored.length, 0);
    assert.equal(unanchored.length, 1);
  });
});

describe('integration: real anchor pipeline (patchLines → buildReviewAnchors → partitionFindings)', () => {
  // New-side numbering starts at +70: ctx70, ctx71, +72, +73, ctx74 → anchorable 70..74.
  const patch = [
    '@@ -70,3 +70,5 @@',
    ' ctxLine70',
    ' ctxLine71',
    '+addedLine72',
    '+addedLine73',
    ' ctxLine74',
  ].join('\n');
  const anchors = buildReviewAnchors([{ filename: 'src/pages/[slug].astro', patch }]);

  test('the anchorable set is exactly the new-side added + context lines', () => {
    assert.deepEqual(
      [...anchors.keys()].sort(),
      ['src/pages/[slug].astro:70', 'src/pages/[slug].astro:71', 'src/pages/[slug].astro:72',
        'src/pages/[slug].astro:73', 'src/pages/[slug].astro:74'].sort(),
    );
  });

  test('the reported failure case: a finding at :79 (just past the hunk) snaps to :74 instead of aborting', () => {
    const { anchored, unanchored } = partitionFindings(
      [{ path: 'src/pages/[slug].astro', line: 79, body: 'stale comment: renderTurns → renderDialogueHtml' }],
      anchors,
    );
    assert.equal(unanchored.length, 0);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].line, 74); // distance 5, within window
  });

  test('a finding far past the hunk (:90) is surfaced as unanchored rather than snapped', () => {
    const { anchored, unanchored } = partitionFindings(
      [{ path: 'src/pages/[slug].astro', line: 90, body: 'far off' }],
      anchors,
    );
    assert.equal(anchored.length, 0);
    assert.equal(unanchored.length, 1);
  });
});

// submitReview: a fake octokit captures the createReview payload so the verdict/body/comment
// behavior is asserted without network I/O.
function fakeOctokit() {
  const calls = [];
  return {
    calls,
    rest: { pulls: { createReview: async args => { calls.push(args); } } },
  };
}

describe('submitReview — unanchored findings', () => {
  test('only unanchored findings still REQUEST_CHANGES and render in the body, with no inline comments', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 'Summary text.',
      findings: [],
      unanchored: [{ path: 's.astro', line: 79, body: 'stale doc comment', severity: 'blocking' }],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'REQUEST_CHANGES');
    assert.equal(arg.comments, undefined); // no inline comments posted
    assert.match(arg.body, /Findings outside the reviewed diff/);
    assert.match(arg.body, /`s\.astro:79`/);
    assert.match(arg.body, /stale doc comment/);
    assert.match(arg.body, /❌ Request Changes/);
  });

  test('anchored findings post inline and add no unanchored section', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 'Summary.',
      findings: [{ path: 'a.js', line: 10, body: 'fix', severity: 'blocking' }],
      unanchored: [],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'REQUEST_CHANGES');
    assert.equal(arg.comments.length, 1);
    assert.equal(arg.comments[0].line, 10);
    assert.doesNotMatch(arg.body, /Findings outside the reviewed diff/);
  });

  test('no findings at all approves (canApprove) and posts no comments', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'Clean.', findings: [], unanchored: [], unreviewedScopes: [] };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'APPROVE');
    assert.equal(arg.comments, undefined);
    assert.match(arg.body, /✅ Approved/);
  });

  test('review without an unanchored field behaves as before (back-compat)', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'Clean.', findings: [], unreviewedScopes: [] }; // no `unanchored` key
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, false, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'COMMENT'); // not approvable, no findings
    assert.doesNotMatch(arg.body, /Findings outside the reviewed diff/);
  });
});

describe('submitReview — dependency section placement', () => {
  test('a dependencySection leads the body, before the summary', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 'The prose summary.',
      findings: [],
      unanchored: [],
      unreviewedScopes: [],
      dependencySection: '**Dependency review** — 1 module(s): 1 ✅ safe\n\n<details>...</details>',
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const { body } = octokit.calls[0];
    assert.match(body, /\*\*Dependency review\*\* — 1 module\(s\): 1 ✅ safe/);
    assert.ok(body.indexOf('Dependency review') < body.indexOf('The prose summary.'), 'the dependency section leads the summary');
  });

  test('no dependencySection leaves the body byte-identical to a plain review', async () => {
    const withField = fakeOctokit();
    const without = fakeOctokit();
    const base = { summary: 'S.', findings: [], unanchored: [], unreviewedScopes: [] };
    await submitReview(withField, 'o', 'r', 1, 'sha', 'Reviewer', { ...base, dependencySection: '' }, true, gitHubTransport([]));
    await submitReview(without, 'o', 'r', 1, 'sha', 'Reviewer', base, true, gitHubTransport([]));
    assert.equal(withField.calls[0].body, without.calls[0].body);
  });
});

// [LAW:types-are-the-program] The dependency-assessment record is validated at the one boundary, exactly
// like a finding: the tool schema IS the type, so an illegal judgment is rejected on the way in.
describe('parseAssessmentValue', () => {
  test('accepts a well-formed assessment and trims strings', () => {
    assert.deepEqual(
      parseAssessmentValue({ module: ' github.com/a/b ', impact: ' adds retries ', affected: true, callSite: ' x.go:1 ', verdict: 'review' }, 0),
      { module: 'github.com/a/b', impact: 'adds retries', affected: true, callSite: 'x.go:1', verdict: 'review' },
    );
  });

  test('a blank/absent callSite collapses to null (a genuine optional, not a guard)', () => {
    assert.equal(parseAssessmentValue({ module: 'm', impact: 'x', affected: false, verdict: 'safe' }, 0).callSite, null);
    assert.equal(parseAssessmentValue({ module: 'm', impact: 'x', affected: false, callSite: '   ', verdict: 'safe' }, 0).callSite, null);
  });

  test('rejects a missing module, blank impact, non-boolean affected, or unknown verdict — naming the position', () => {
    assert.throws(() => parseAssessmentValue({ impact: 'x', affected: true, verdict: 'safe' }, 0), /assessment 1 has an invalid module/);
    assert.throws(() => parseAssessmentValue({ module: 'm', impact: '  ', affected: true, verdict: 'safe' }, 1), /assessment 2 \('m'\) has an invalid impact/);
    assert.throws(() => parseAssessmentValue({ module: 'm', impact: 'x', affected: 'yes', verdict: 'safe' }, 2), /assessment 3 \('m'\) has an invalid affected/);
    assert.throws(() => parseAssessmentValue({ module: 'm', impact: 'x', affected: true, verdict: 'meh' }, 3), /assessment 4 \('m'\) has an invalid verdict/);
  });
});

describe('dedupeAssessments', () => {
  test('collapses repeat assessments of one module to the MOST CAUTIOUS verdict, keeping first-seen position', () => {
    const out = dedupeAssessments([
      { module: 'github.com/a/b', impact: 'safe take', affected: false, callSite: null, verdict: 'safe' },
      { module: 'github.com/c/d', impact: 'other', affected: false, callSite: null, verdict: 'review' },
      { module: 'github.com/a/b', impact: 'risky take', affected: true, callSite: 'x.go:1', verdict: 'risky' },
    ]);
    assert.equal(out.length, 2);
    // risky (more cautious) beats the earlier safe — and the whole cautious assessment is what shows.
    assert.equal(out[0].verdict, 'risky');
    assert.equal(out[0].impact, 'risky take');
    assert.deepEqual(out.map(a => a.module), ['github.com/a/b', 'github.com/c/d']); // position preserved
  });

  test('a later LESS-cautious verdict never downgrades an earlier cautious one', () => {
    const out = dedupeAssessments([
      { module: 'github.com/a/b', impact: 'risky', affected: true, callSite: 'x', verdict: 'risky' },
      { module: 'github.com/a/b', impact: 'safe', affected: false, callSite: null, verdict: 'safe' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].verdict, 'risky'); // safe-later never masks risky-earlier
  });

  test('an empty list is []', () => {
    assert.deepEqual(dedupeAssessments([]), []);
  });
});

// [LAW:verifiable-goals] AC (home-copirate-review-9uj.12): Gitea's ReviewStateType enum spells
// approval 'APPROVED' (past tense), not GitHub's imperative 'APPROVE'. Gitea's create-review
// handler has no error branch for an unrecognized event string — it silently falls through to
// ReviewTypePending — so sending GitHub's spelling produced a 200 response with the review stuck
// at state=PENDING forever, with no error anywhere in the chain. Reproduced live against Gitea
// v1.27.1: a raw API call with event='APPROVE' returned state=PENDING; the identical call with
// event='APPROVED' returned state=APPROVED. Each transport must supply the event string its own
// host actually recognizes.
describe('submitReview — approve event spelling is host-specific (home-copirate-review-9uj.12)', () => {
  test('gitHubTransport approves with GitHub\'s imperative spelling', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'Clean.', findings: [], unanchored: [], unreviewedScopes: [] };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    assert.equal(octokit.calls[0].event, 'APPROVE');
  });

  test('giteaTransport approves with Gitea\'s ReviewStateType spelling, not GitHub\'s', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'Clean.', findings: [], unanchored: [], unreviewedScopes: [] };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, giteaTransport([]));
    assert.equal(octokit.calls[0].event, 'APPROVED');
  });

  test('REQUEST_CHANGES is spelled identically across transports (no host-specific mapping needed)', async () => {
    const review = { summary: 'Bad.', findings: [{ path: 'a.js', line: 1, body: 'x', severity: 'blocking' }], unanchored: [], unreviewedScopes: [] };
    const gh = fakeOctokit();
    await submitReview(gh, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const gt = fakeOctokit();
    await submitReview(gt, 'o', 'r', 1, 'sha', 'Reviewer', review, true, giteaTransport([]));
    assert.equal(gh.calls[0].event, 'REQUEST_CHANGES');
    assert.equal(gt.calls[0].event, 'REQUEST_CHANGES');
  });
});

// ── severity: the discriminator that separates "worth surfacing" from "worth blocking" ────────────
// [LAW:verifiable-goals] AC: recording a finding no longer forces REQUEST_CHANGES — an advisory
// finding still posts and still counts, but the verdict blocks only on a 'blocking' finding.

describe('parseFindingValue — severity', () => {
  test('accepts a blocking finding and carries severity through', () => {
    assert.deepEqual(
      parseFindingValue({ path: 'a.js', line: 3, body: 'bug', severity: 'blocking' }, 0),
      { path: 'a.js', line: 3, body: 'bug', severity: 'blocking' },
    );
  });
  test('accepts an advisory finding', () => {
    assert.equal(parseFindingValue({ path: 'a.js', line: 3, body: 'nit', severity: 'advisory' }, 0).severity, 'advisory');
  });
  test('rejects a missing severity — the field is required', () => {
    assert.throws(() => parseFindingValue({ path: 'a.js', line: 3, body: 'x' }, 0), /invalid severity/);
  });
  test('rejects an unknown severity value', () => {
    assert.throws(() => parseFindingValue({ path: 'a.js', line: 3, body: 'x', severity: 'critical' }, 0), /invalid severity/);
  });
  test('the error names the caller-supplied position, not always "finding 1"', () => {
    // parseFindingValue(index=5) must report "finding 6" — the record's real position — so a bad
    // finding deep in records.jsonl is locatable, not mislabeled as the first. [LAW:decomposition]
    assert.throws(() => parseFindingValue({ path: 'a.js', line: 3, body: 'x', severity: 'nope' }, 5), /finding 6 has an invalid severity/);
    assert.throws(() => parseFindingValue({ path: '', line: 3, body: 'x', severity: 'blocking' }, 2), /finding 3 has an invalid path/);
  });
});

describe('severityTaggedBody', () => {
  test('prefixes an advisory finding so a reader can tell it apart', () => {
    assert.equal(severityTaggedBody({ body: 'missing test', severity: 'advisory' }), '**Advisory (non-blocking):** missing test');
  });
  test('leaves a blocking finding body untagged', () => {
    assert.equal(severityTaggedBody({ body: 'off-by-one', severity: 'blocking' }), 'off-by-one');
  });
});

describe('partitionFindings — severity carried through', () => {
  test('severity survives an exact anchor and a snap', () => {
    const anchors = anchorsFor([['a.js', 10], ['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'exact', severity: 'advisory' },
      { path: 'a.js', line: 14, body: 'near', severity: 'blocking' }, // snaps to 12
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored[0].severity, 'advisory');
    assert.equal(anchored[1].severity, 'blocking'); // snapped, severity intact
  });
});

// [LAW:verifiable-goals] AC (zai-hardening-g4v.4): two findings the model recorded on DIFFERENT nearby
// lines can snap onto the SAME anchor line. Pre-anchor dedup can't catch them (their lines differ), so
// partitionFindings collapses them AFTER snapping — but keyed on the ORIGINAL body, since the snap note
// (which cites each finding's own pre-snap line) would otherwise differ and defeat the collapse.
describe('partitionFindings — collapses near-duplicates that snap onto one line', () => {
  test('two findings on different pre-snap lines with equivalent bodies post once', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'Bug: off-by-one in the loop' }, // snaps to 12
      { path: 'a.js', line: 14, body: 'Bug: off-by-one in the loop' }, // snaps to 12
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].line, 12);
    // Survivor is first-seen; its note cites ITS OWN pre-snap line (10), never the other member's.
    assert.match(anchored[0].body, /Anchored to line 12; the review referenced line 10/);
  });

  test('two findings snapping to one line with DISTINCT bodies both post', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'Bug: off-by-one in the loop' },
      { path: 'a.js', line: 14, body: 'Edge case: empty input crashes' },
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 2);
    assert.deepEqual(anchored.map(f => f.line), [12, 12]);
  });

  test('collapse uses the SHARED normalization — bodies differing only in whitespace/case merge', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'Fix   the   NULL check' },
      { path: 'a.js', line: 14, body: 'fix the null check' },
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 1);
  });

  test('an exact-anchor finding and an equivalent snapped one collapse; the on-grid survivor is unannotated', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 12, body: 'Bug: race on shared map' }, // exact, first-seen
      { path: 'a.js', line: 14, body: 'Bug: race on shared map' }, // snaps to 12, same key
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 1);
    assert.deepEqual(anchored[0], { path: 'a.js', line: 12, body: 'Bug: race on shared map' });
  });

  test('[LAW:no-silent-failure] collapse keeps the stronger severity regardless of arrival order', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 10, body: 'Bug: same issue', severity: 'advisory' },
      { path: 'a.js', line: 14, body: 'Bug: same issue', severity: 'blocking' }, // arrives later
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].severity, 'blocking');
  });

  test('[LAW:no-silent-failure] severity-driven replacement swaps which candidate survives — the snapped blocking one wins AND is annotated', () => {
    // The first-seen survivor is an EXACT-anchored advisory (no snap note); a later SNAPPED blocking
    // finding with the same normalized body replaces it via blocking-wins. The survivor must flip both
    // its severity (→ blocking) and its annotation state (→ carries the snap note of the snapped member).
    const anchors = anchorsFor([['a.js', 12]]);
    const findings = [
      { path: 'a.js', line: 12, body: 'Bug: same issue', severity: 'advisory' }, // exact, first-seen
      { path: 'a.js', line: 14, body: 'Bug: same issue', severity: 'blocking' }, // snaps to 12, replaces
    ];
    const { anchored } = partitionFindings(findings, anchors);
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0].line, 12);
    assert.equal(anchored[0].severity, 'blocking');
    assert.match(anchored[0].body, /Anchored to line 12; the review referenced line 14/);
    assert.equal('snappedFromLine' in anchored[0], false);
  });

  test('snappedFromLine scaffolding never leaks onto an anchored finding', () => {
    const anchors = anchorsFor([['a.js', 12]]);
    const { anchored } = partitionFindings([{ path: 'a.js', line: 14, body: 'x' }], anchors);
    assert.equal(anchored.length, 1);
    assert.equal('snappedFromLine' in anchored[0], false);
  });
});

describe('submitReview — severity drives the verdict, never whether a finding is recorded', () => {
  test('all-advisory findings APPROVE (canApprove) yet still post inline, tagged', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 'Two non-blocking notes.',
      findings: [
        { path: 'a.js', line: 10, body: 'add a test', severity: 'advisory' },
        { path: 'b.js', line: 20, body: 'could be faster', severity: 'advisory' },
      ],
      unanchored: [],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'APPROVE'); // recording advisory findings does NOT block the merge
    assert.match(arg.body, /✅ Approved/);
    assert.equal(arg.comments.length, 2); // advisory findings still post inline
    assert.match(arg.comments[0].body, /^\*\*Advisory \(non-blocking\):\*\* add a test/);
  });

  test('all-advisory findings post as COMMENT when the token cannot approve', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 's', findings: [{ path: 'a.js', line: 1, body: 'nit', severity: 'advisory' }], unanchored: [], unreviewedScopes: [] };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, false, gitHubTransport([]));
    assert.equal(octokit.calls[0].event, 'COMMENT');
  });

  test('one blocking finding among advisories forces REQUEST_CHANGES', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 's',
      findings: [
        { path: 'a.js', line: 10, body: 'nit', severity: 'advisory' },
        { path: 'b.js', line: 20, body: 'real bug', severity: 'blocking' },
      ],
      unanchored: [],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    assert.equal(octokit.calls[0].event, 'REQUEST_CHANGES');
  });

  test('a blocking UNANCHORED finding still blocks — a mis-anchored blocker cannot downgrade to APPROVE', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 's',
      findings: [{ path: 'a.js', line: 10, body: 'nit', severity: 'advisory' }],
      unanchored: [{ path: 'b.js', line: 999, body: 'real bug off-grid', severity: 'blocking' }],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'REQUEST_CHANGES');
    assert.match(arg.body, /Findings outside the reviewed diff/);
  });

  test('an advisory unanchored finding is tagged in the summary section', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 's',
      findings: [],
      unanchored: [{ path: 'b.js', line: 999, body: 'perf note off-grid', severity: 'advisory' }],
      unreviewedScopes: [],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'APPROVE'); // advisory-only, even unanchored, does not block
    assert.match(arg.body, /\*\*Advisory \(non-blocking\):\*\* perf note off-grid/);
  });
});

// ── partial coverage withholds approval (zai-timing-sn1) ──────────────────────────────────────────
// A review whose time budget expired before every scope was reviewed has no standing to approve:
// approval asserts the whole diff was judged. Blocking findings outrank the partial state.
describe('submitReview — partial coverage (unreviewedScopes)', () => {
  test('clean-but-partial posts as COMMENT with the partial verdict, never Approved — even with an approve-capable token', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'S.', findings: [], unanchored: [], unreviewedScopes: ['store', 'docs'] };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'COMMENT');
    assert.match(arg.body, /⏳ Partial review/);
    assert.doesNotMatch(arg.body, /✅ Approved/);
  });

  test('a blocking finding in a partial review still REQUEST_CHANGES — a blocker found in a half-reviewed diff is still a blocker', async () => {
    const octokit = fakeOctokit();
    const review = {
      summary: 'S.',
      findings: [{ path: 'a.js', line: 1, body: 'bug', severity: 'blocking' }],
      unanchored: [],
      unreviewedScopes: ['docs'],
    };
    await submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([]));
    const arg = octokit.calls[0];
    assert.equal(arg.event, 'REQUEST_CHANGES');
    assert.match(arg.body, /❌ Request Changes/);
  });

  test('a review that omits unreviewedScopes crashes loud — coverage is a required part of the review value', async () => {
    const octokit = fakeOctokit();
    const review = { summary: 'S.', findings: [], unanchored: [] };
    delete review.unreviewedScopes;
    await assert.rejects(
      submitReview(octokit, 'o', 'r', 1, 'sha', 'Reviewer', review, true, gitHubTransport([])),
      TypeError,
    );
    assert.equal(octokit.calls.length, 0, 'nothing was posted for an out-of-contract review value');
  });
});
