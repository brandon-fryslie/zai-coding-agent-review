'use strict';
const { annotatePatchWithLines } = require('./diff');

// [LAW:one-source-of-truth] The REVIEW PHILOSOPHY lives here, once, shared by both the PR-diff and
// whole-repo review builders. It is deliberately NOT a laws-compliance audit: a code review exists to
// stop bugs, breakage, and security holes from merging — the architectural laws are ONE secondary
// structural lens that ranks below "will this ship a defect". The two builders differ only in their
// MATERIAL (diff vs working tree) and ANCHORING (LINE N vs any line); the standard of what a good
// review IS does not differ, so it is a value both interpolate rather than two copies that drift.
// [LAW:decomposition] Correctness-hunting and law-auditing are two concerns; this orders them by the
// cost of missing each — a shipped bug is expensive, an ugly-but-working function is not.
function reviewCharter(toolNames) {
  return `Your job is to catch what would hurt if it shipped. Be thorough and adversarial: for each
    line you examine, ask "how does this go wrong? what input breaks it? what did the author assume that
    isn't guaranteed?" Do not stop at the first finding — a thorough pass usually surfaces several. A
    miss is far more expensive than a false alarm, so when you are moderately (not fully) sure a line is
    wrong, still record it — as an 'advisory' finding (see severity below) — and say what you're unsure
    of. Recording every genuine issue is the goal; the severity field, not silence, is how you mark one
    non-blocking. For pure style, naming, and formatting, stay silent.

    Hunt in this order — highest cost-of-missing first:
    1. Correctness bugs — the code does not do what it plainly intends. Wrong operator or comparison,
       inverted or short-circuited condition, off-by-one, wrong variable, bad default, an ignored
       return value, a missing \`await\` so a promise is used unresolved, an error/callback path that
       never runs. Trace the changed code with real values in your head.
    2. Unhandled edge cases — empty, null/undefined, zero, negative, a single element, a huge input,
       duplicate keys, missing field, out-of-range index, unicode, an error thrown mid-operation. The
       happy path usually works; bugs live at the boundaries. Name the exact input that breaks it.
    3. Breakage & regressions — a broken caller, a changed public signature/return shape/serialized or
       on-disk format/config key/migration path, a removed or renamed export still used elsewhere, a
       default that shifts under existing callers.
    4. Security — untrusted input reaching a shell/SQL/path/eval/template sink; missing authz/authn; a
       secret logged or returned; unsafe deserialization; SSRF; a widened privilege. Follow the data
       from its untrusted source to where it is used.
    5. Concurrency & data integrity — a race, a lost update, a non-idempotent retry, a TOCTOU gap, a
       dual write, an ordering assumption nothing enforces.
    6. Silent failure — a swallowed error, an empty catch, \`|| true\`, \`2>/dev/null\`, a fallback that
       quietly returns different data when the real source fails. Errors must surface, not vanish. [LAW:no-silent-failure]
    7. Resource & lifecycle — an unclosed file/socket/connection, a leaked handle or listener, a timer
       never cleared, a lock never released, unbounded growth.
    8. Missing tests for risky logic — new non-trivial behavior with no test over its failure modes, or
       a test that asserts implementation instead of behavior. [LAW:behavior-not-structure]
    9. Performance on real paths — accidental O(n²), N+1 queries, work repeated in a loop that could be
       hoisted, blocking a hot path.
    10. Architecture & maintainability — genuine structural problems that will cost maintainers: a part
       doing several things, a type that admits illegal states, a fact with two sources of truth that
       can drift, effects tangled through pure logic, a dependency cycle. These map to the [LAW:*] tokens
       in your guidance; cite the token when one fits. These are real, but they rank BELOW "will this
       ship a bug" — record a clean-architecture nit as 'advisory', never blocking; a correctness bug in
       ugly-but-working code is always 'blocking'.

    Set each finding's severity by where it falls in that list. Categories 1–7 (correctness, edge cases,
    breakage, security, concurrency, silent failure, resource/lifecycle) default to 'blocking' — they
    must change before merge. Categories 8–10 (missing tests, performance, architecture/maintainability)
    default to 'advisory' — record them so they are not lost, but they do not block the merge. A finding
    you are only moderately sure of is 'advisory', not withheld. Never drop a genuine issue because it is
    non-blocking; give it the right severity and record it — the action blocks the merge only when at
    least one finding is 'blocking', so an advisory finding is always safe to record.

    Each ${toolNames.requestChange} body has three parts, in order: (1) a short tag naming the kind —
    Bug, Edge case, Breaking, Security, Race, Silent failure, Resource leak, Perf, or a [LAW:token] for
    a structural issue; (2) one or two sentences saying WHAT goes wrong and HOW it manifests — the
    concrete failure and, where you can, the exact input or sequence that triggers it, not just a
    label; (3) the concrete fix. Lead with the impact, not the category. One comment per distinct issue
    — flag the clearest instance and note the pattern once; do not repeat it across many lines.

    Do not invent rules, and do not request changes for style, naming preference, or speculative
    "might one day". Every finding names a concrete way the code misbehaves, breaks a caller, or will
    bite a maintainer. Do NOT state an overall verdict, approval status, or a finding count — the action
    derives the verdict from the recorded changes and appends it itself.`;
}

// toolNames is required; callers supply adapter.toolNames so each engine's actual
// MCP tool identifiers are interpolated into the prompt. [LAW:composability]
// reviewedRepoRoot is the absolute path of the checked-out repo. The engine spawns with a
// working directory OUTSIDE that tree (so no repo-committed CLAUDE.md/AGENTS.md is auto-loaded
// as reviewer instructions), so the repo is named here as an explicit value and the agent reads
// it by absolute path — never via cwd-relative discovery. [LAW:effects-at-boundaries]
// focus is a free-text value naming the part of the change this review should concentrate on (a
// multi-scope worker's scope). [LAW:dataflow-not-control-flow] '' is the broad whole-diff review
// (the single-scope case); a non-empty value narrows attention — the same prompt, varied by value,
// never a branch. The whole annotated diff is shown either way so every anchor stays valid.
// scopeFiles is this worker's assigned changed files: it reads THOSE in full, not the whole changed
// set, so N workers cost ~1× the read of the changed set (split), not N× (duplicated). Empty scopeFiles
// is the whole-set read (single-scope PR, or repo mode) — a value, not a branch. [LAW:decomposition]
// dependencyDiffNote is a value, not a mode: '' (the common case — no dependency-manifest bump,
// or the DEPENDENCY_DIFF input off) renders nothing; a non-empty note (src/dependency-diff.js)
// appends the fetched upstream-change context after the diff, same placement as the unshowable-
// files note below. [LAW:dataflow-not-control-flow]
function buildReviewInput(files, maxDiffChars, toolNames, reviewedRepoRoot, focus = '', scopeFiles = [], dependencyDiffNote = '', dependencyBumps = []) {
  const patchableFiles = files.filter(f => f.patch);
  const includedDiffs = [];
  const includedFiles = [];
  // [LAW:one-type-per-behavior] A file GitHub returns without a patch (too large — roughly >400 changed
  // lines — or binary) and a file whose diff overran the MAX_DIFF_CHARS budget are the SAME behavior: a
  // changed file whose diff cannot be shown inline. They are two instances of one type, not two modes, so
  // they merge into ONE list and one rendered block. Patchless files were previously filtered out at
  // `f.patch` and vanished silently while the scout still assigned them to a scope (buildPrMaterial hands
  // the scout every filename), so workers hunted for diff lines that did not exist. [LAW:no-silent-failure]
  const unshowableFiles = files.filter(f => !f.patch).map(f => f.filename);
  let totalChars = 0;

  for (const f of patchableFiles) {
    const entry = `### ${f.filename} (${f.status})\n\`\`\`diff\n${annotatePatchWithLines(f.patch)}\n\`\`\``;
    if (maxDiffChars > 0 && totalChars + entry.length > maxDiffChars) {
      unshowableFiles.push(f.filename);
    } else {
      includedDiffs.push(entry);
      includedFiles.push(f);
      totalChars += entry.length;
    }
  }

  let diffs = includedDiffs.join('\n\n');

  // [LAW:dataflow-not-control-flow] The unshowable set is a VALUE: an empty list renders nothing, so this
  // is one path, not a "patchless mode". The note names the recovery route the pipeline already owns —
  // unanchored findings reported via finish_review are counted toward the verdict (transport.js), so the
  // riskiest (biggest) changed files stay reviewable even though their diff cannot be anchored inline.
  if (unshowableFiles.length > 0) {
    diffs += `\n\n> **Note:** These changed files' diffs could not be shown (too large or binary, or the diff exceeded \`MAX_DIFF_CHARS\`). Read each in full at its absolute path, review its changes, and because its lines cannot be anchored inline, report any issues via the ${toolNames.finishReview} summary rather than ${toolNames.requestChange}:\n${unshowableFiles.map(f => `> - ${reviewedRepoRoot}/${f}`).join('\n')}`;
  }

  if (dependencyDiffNote) {
    diffs += `\n\n${dependencyDiffNote}`;
  }

  // [LAW:dataflow-not-control-flow] focus renders as a value: '' yields no block, a scope yields a
  // concentration instruction. The worker sees the whole diff (anchors stay valid) and concentrates
  // its deepest reading on the named part, but records EVERY genuine issue it notices anywhere —
  // suppressing out-of-scope findings would be control flow ("don't run the report") solving a problem
  // the pipeline already solves as dataflow: overlap is de-duplicated when scopes' findings merge
  // (dedupeFindings), so a finding another worker may also catch costs nothing to report and is never
  // silently withheld. [LAW:no-silent-failure]
  const focusBlock = focus
    ? `\n    CONCENTRATE THIS REVIEW on one part of the change: ${focus}\n    The whole diff is shown below both for context and because you must not stay silent about a real bug just because it falls outside this part. Read the named part most deeply, but if you notice a genuine issue ANYWHERE in the diff, still record it with ${toolNames.requestChange} (assigning severity as usual). Overlapping findings are de-duplicated downstream, so nothing is lost by reporting an issue another review may also catch.\n`
    : '';

  // [LAW:dataflow-not-control-flow] A value again: no upstream note means no instruction block.
  // When present, tell the worker WHAT to do with the fetched upstream context — cross-check it
  // against this repo's own usage rather than just reading it as trivia.
  const dependencyInstructionBlock = dependencyDiffNote
    ? `\n    This PR bumps a dependency version. Upstream commit/file context for that bump is included below (the
    section starting "Dependency version bump"). Use \`Grep\` to find where this repo calls into the bumped
    module, then judge whether anything in the upstream range breaks, deprecates, or changes the behavior of a
    symbol this repo actually uses — a removed export, a changed function signature, a changed default, a
    renamed field. If nothing this repo uses is affected, say so briefly in the ${toolNames.finishReview}
    summary; if something is, name the exact upstream change and the call site it affects at 'blocking'
    severity — as ${toolNames.requestChange} on the go.mod version line if that line is shown above (a LINE N
    anchor), or in the ${toolNames.finishReview} summary if go.mod's own diff was too large to show inline
    (see the unshowable-files note above) — never silently drop the finding because the anchor isn't available.\n`
    : '';

  // [LAW:dataflow-not-control-flow] The assess directive is rendered by a VALUE, not a mode: it fires only
  // for the worker whose assigned files include the bumped go.mod, so exactly ONE worker authors the
  // per-module assessments (dedupeAssessments collapses the multi-go.mod case downstream). Any other
  // worker — and every non-dependency PR (dependencyBumps === []) — renders nothing. The assessment is the
  // SUMMARY-level judgment the host folds into the review's dependency section; it does NOT replace the
  // blocking finding a real break still requires (that is what drives the merge verdict). [LAW:no-silent-failure]
  const ownsBumpedGoMod = dependencyBumps.length > 0
    && scopeFiles.some(f => f === 'go.mod' || f.endsWith('/go.mod'));
  // [FRAMING:representation] List DISTINCT module paths: when two go.mod files bump the same module the raw
  // map repeats it, and "EACH ... exactly ONCE" turns ambiguous. dedupeAssessments would still collapse a
  // double call, but the directive should name each module once.
  const bumpedModules = [...new Set(dependencyBumps.map(b => b.modulePath))];
  const dependencyAssessBlock = ownsBumpedGoMod
    ? `\n    You own this PR's go.mod bump. For EACH of these bumped modules, call ${toolNames.assessDependency} exactly
    ONCE, copying the module path VERBATIM: ${bumpedModules.join(', ')}. Provide your
    merge-risk judgment as fields: 'impact' (ONE line synthesizing what materially changed upstream from the
    commit context above — not a list of commits), 'affected' (true/false — does THIS repo's own usage break or
    change?), 'callSite' (the file or file:line where, when affected — omit when not), and 'verdict' ('safe' =
    routine, merge freely; 'review' = worth a human glance; 'risky' = a breaking change that touches this repo).
    The host renders this into the review's dependency summary. It does NOT replace a finding: if the bump breaks
    a symbol this repo uses, still record that as a 'blocking' ${toolNames.requestChange} (or in the ${toolNames.finishReview}
    summary if unanchorable), because the assessment's verdict is presentation — findings drive the merge decision.\n`
    : '';

  // [LAW:dataflow-not-control-flow] The set of files to read in full is a VALUE: a non-empty scopeFiles
  // narrows the full read to this worker's assigned files (another worker reads the rest — the read cost
  // is split, not duplicated N times); an empty scopeFiles reads the whole changed set (single-scope PR
  // or repo mode). Either way the whole diff is shown, so cross-file context and report-anywhere are
  // unchanged — only the expensive full-file reads are partitioned.
  const readTargets = scopeFiles.length > 0
    ? `Read the complete content of THESE files — this scope's assigned changed files: ${scopeFiles.join(', ')}. `
      + `Skip any among them that are generated or vendored artifacts (bundled or minified output, lockfiles) or pure documentation. `
      + `Another scope's worker reads the other changed files, so do NOT read them in full — that duplicates their work and their cost. `
      + `You may consult a file your assigned files import when a specific finding needs it: prefer Grep to confirm a symbol or signature `
      + `over Reading the whole file, and read an imported file in full only when a finding truly requires it. Do not pre-read the tree.`
    : `Read the complete content of every changed file that contains code — skip only generated or vendored `
      + `artifacts (bundled or minified output, lockfiles) and pure documentation. Test files count: read them.`;

  return {
    // [LAW:one-source-of-truth] The same included files define Claude's visible diff and valid review anchors.
    files: includedFiles,
    prompt: `
Review this pull request. The repository under review is checked out at ${reviewedRepoRoot}.
    Your working directory is intentionally outside the repository; reach it by that absolute path with your Read tool.
${focusBlock}${dependencyInstructionBlock}${dependencyAssessBlock}
    BEFORE judging anything, ${readTargets} The diff shows only the changed hunks; most bugs are only
    visible in the full surrounding context of the function and module — a missing guard, a caller you'd
    break, a value that can't be what this line assumes. Do not form or report any judgment until you
    have read the files you are responsible for in full.

    Each visible diff line is annotated as LINE N. Call ${toolNames.requestChange} for each issue you
    find. Every recorded change must use path, line (the displayed LINE value), body, and severity
    ('blocking' if it must change before merge, 'advisory' otherwise — see the charter below). When the
    review is complete, call ${toolNames.finishReview} exactly once with a concise
    summary. The collector tools are the only review output channel; you flag issues, you do not fix them.

    Flag any problem this change introduces or is now responsible for — a bug or risk in the code this
    diff adds, or in existing code it now relies on or feeds. Pre-existing problems in code this PR does
    not touch are not this review's job; note only the significant ones in the ${toolNames.finishReview}
    summary. You can ONLY attach a comment to a line shown as LINE N — a line this diff added or kept as
    context; the host does not allow comments on unchanged or deleted code. When the change creates a
    problem whose root cause sits in unchanged code (it feeds a bad value into an existing function, or
    relies on an existing loose type), attach the comment to the changed LINE responsible for the new
    problem and explain the upstream link in the body. If a real finding cannot be tied to any changed
    LINE, put it in the ${toolNames.finishReview} summary rather than dropping it.

    ${reviewCharter(toolNames)}
    \n\n${diffs}`,
  };
}

// [LAW:decomposition] The full-repo material: there is no diff, so this prompt carries no
// annotated LINE grid and produces no anchors — it instructs the engine to explore the working
// tree itself with its allowed Read/Grep/Glob tools. Unlike buildReviewInput (a pull-request
// diff, where only diff-introduced violations are request_change material), a whole-repo review
// deliberately flags PRE-EXISTING issues — that is the point of the mode.
// scope is free text that focuses the review; '' means a broad whole-repo pass.
// excludePatterns is a value the prompt forwards as "do not review these"; with no diff to
// filter, the agent honors it while exploring. [LAW:dataflow-not-control-flow] empty scope and
// empty excludePatterns are distinct values with distinct renderings, not skipped branches.
// reviewedRepoRoot is the absolute path of the checked-out repo, named explicitly because the
// engine's working directory is OUTSIDE the tree (so no repo-committed AGENTS.md/CLAUDE.md loads
// as reviewer instructions); the agent explores the repo by that absolute path. [LAW:effects-at-boundaries]
function buildRepoReviewInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }) {
  const focus = scope
    ? `Focus this review on the following scope, named by the maintainer: ${scope}. Start from the files and modules that scope points to, and follow the code from there.`
    : `Give a broad review across the whole repository. Start from the entry points and the modules most central to the project, and read the actual source before judging it.`;
  const exclude = excludePatterns.length > 0
    ? `\n\n    Do NOT review files matching these excluded patterns: ${excludePatterns.join(', ')}.`
    : '';

  return {
    prompt: `
Review this repository for what would hurt if it shipped. There is no diff — the repository under review is checked out
    at ${reviewedRepoRoot}; explore it yourself using your Read, Grep, and Glob tools against that absolute path (your
    working directory is intentionally outside the repository) and judge the code you find. ${focus}${exclude}

    Call ${toolNames.requestChange} for each issue you find, with path, line (any real line in that file —
    there is no diff grid here, so any line is valid), a body, and a severity ('blocking' if it must change
    before merge, 'advisory' otherwise — see the charter below). When the review is complete, call
    ${toolNames.finishReview} exactly once with a concise summary. The collector tools are the only review output channel.

    This is a whole-repository audit, so PRE-EXISTING issues in any file ARE in scope — that is the point of this mode.
    This is an informational report, not a merge gate.

    ${reviewCharter(toolNames)}`,
  };
}

// [LAW:one-source-of-truth] The scout's OUTPUT protocol lives here, once, shared by both scout
// builders below. A scout plans the review; it does not flag code. It records each scope through the
// add_scope COLLECTOR TOOL — a typed, schema-validated record, exactly as a worker records a finding
// through request_change — so the plan is never parsed from prose. [FRAMING:representation] The number
// of scopes is whatever the grouping rules produce — adaptivity is the grouping, never a counted
// threshold. [LAW:dataflow-not-control-flow]
// assignFiles adds the `files` field to the contract: in PR mode the scout assigns every changed file
// to exactly one scope (its worker reads those in full), so the field is required; in repo mode there
// is no diff to partition, so the contract omits it. [LAW:dataflow-not-control-flow] one contract,
// varied by a value, not two copies.
function scoutOutputContract(toolNames, { assignFiles = false } = {}) {
  const filesField = assignFiles
    ? `\n      - files: the array of changed file paths this scope owns, copied EXACTLY as listed above. `
      + `Every changed file must appear in exactly ONE scope's files — the worker for that scope reads those files in full.`
    : '';
  return `Do NOT call ${toolNames.requestChange}. You are planning the review here, not reviewing code.

    Record your plan by calling ${toolNames.addScope} ONCE PER SCOPE, providing:
      - name: a short label (for example "cost", "line-anchoring", or "parser→renderer" for a boundary).
      - focus: one or two sentences naming the exact files and what to examine in them.${filesField}

    Then call ${toolNames.finishReview} exactly once, with a summary of two to four plain sentences
    describing what this codebase is and how its main parts relate. Do NOT list the scopes in the
    summary — the scopes ARE your ${toolNames.addScope} calls. These collector tools are your only
    output channel; never print the plan as text.`;
}

// [LAW:decomposition] The PR scout MATERIAL: it is handed the list of files this pull request changed
// and divides them into review scopes by the explicit rules below. It surveys; the workers judge.
// The rules are written for a weak model — concrete, example-grounded, and free of any "is it big"
// threshold: the scope COUNT falls out of grouping changed files by concern and following the import
// edges the change actually crosses. [LAW:dataflow-not-control-flow]
function buildPrScoutInput({ changedPaths, toolNames, reviewedRepoRoot }) {
  const fileList = changedPaths.map(p => `      - ${p}`).join('\n');
  return {
    prompt: `
Plan the review of a pull request. The repository under review is checked out at ${reviewedRepoRoot}; your working
    directory is intentionally outside it, so reach files by that absolute path with your Read, Grep, and Glob tools.

    This pull request changed these source files:
${fileList}

    Divide these changed files into review scopes by this ONE rule. Do not invent scopes for anything these files do not
    change.

    Group the changed files by the ONE concern each serves, and emit exactly ONE scope per group — no more. [LAW:decomposition]:
    a part does one thing, so each group is one concern. A concern is usually the directory a file sits in, but judge by what
    the code DOES, not only where it sits. Read the changed files if you are unsure what they do.
      - Example: a change to a price table and a change to the function that reads that table both serve the
        cost concern — ONE group, ONE scope, though they are different files.
      - Example: a change to line-anchor parsing and a change to report rendering serve two different
        concerns — TWO groups, TWO scopes.

    The number of scopes EQUALS the number of distinct concerns these changed files touch: a change to one concern yields
    exactly one scope; a change touching five concerns yields exactly five scopes. Do NOT split one concern across several
    scopes, and do NOT create a separate scope for a boundary between concerns — boundaries are reviewed from inside a scope,
    next. EVERY changed file listed above must belong to exactly one scope — none left out, or its changes go unreviewed.

    In each scope's "focus", do THREE things: (1) name that group's changed files and what to review in them; (2) tell the
    reviewer to ALSO read the files this group imports (its require(...) targets) and check the connection — that the
    dependency points one way [LAW:one-way-deps] and that no single fact is defined or owned on both sides
    [LAW:one-source-of-truth]; (3) keep it to one or two sentences.

    Separately, put that group's changed file paths in the scope's "files" field — that is the set the scope's worker reads in full.

    ${scoutOutputContract(toolNames, { assignFiles: true })}`,
  };
}

// [LAW:decomposition] The whole-repo scout MATERIAL: no diff, so it surveys the working tree and
// divides the SOURCE (not just changed files) into scopes by the same concern-grouping rules. scope
// is optional free text that narrows where planning starts; excludePatterns are forwarded as "never
// scope these". [LAW:dataflow-not-control-flow] empty scope and empty excludePatterns are distinct
// rendered values, not skipped branches.
function buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }) {
  // [LAW:dataflow-not-control-flow] The maintainer's focus is a BOUND on grouping, not a soft hint:
  // when present, scopes may only cover files inside the focus and the files those import. Absent, the
  // whole repository is in bounds. This is the fix for a weak model that otherwise "follows the code
  // outward" until it has re-scoped the entire repo.
  const boundLine = scope
    ? `The maintainer has focused this review on: ${scope}\n    IMPORTANT: create scopes ONLY for files inside that focus and the files those files directly import. Do NOT create scopes for unrelated parts of the repository, even ones you notice while surveying.`
    : 'Cover the whole repository: every distinct concern in the source is in bounds.';
  const exclude = excludePatterns.length > 0
    ? `\n\n    Do NOT include files matching these excluded patterns in any scope: ${excludePatterns.join(', ')}.`
    : '';
  return {
    prompt: `
Plan the review of this repository. There is no diff. The repository under review is checked out at ${reviewedRepoRoot};
    your working directory is intentionally outside it, so explore by that absolute path with your Read, Grep, and Glob tools.
    ${boundLine}${exclude}

    First, survey the structure: read the entry points, the package manifest, and one key file per major part so you
    understand what the parts are and how they relate. Then divide the IN-BOUNDS source into review scopes by this ONE rule.

    Group the in-bounds source by the ONE concern each part serves, and emit exactly ONE scope per group — no more.
    [LAW:decomposition]: a part does one thing, so each group is one concern. A concern is usually a single directory,
    but judge by what the code DOES, not only where it sits.
      - Example: a price table and the function that reads that table both serve the cost concern — ONE group, ONE scope.
      - Example: line-anchor parsing and report rendering serve two concerns — TWO groups, TWO scopes.

    The number of scopes EQUALS the number of distinct concerns in bounds — nothing else. A small or tightly focused review
    yields few scopes; a whole large repository yields one scope per concern. Do NOT split one concern across several scopes,
    and do NOT create a separate scope for a boundary between concerns — boundaries are reviewed from inside a scope, next.

    In each scope's "focus", do THREE things: (1) name that group's files and what to review in them; (2) tell the reviewer
    to ALSO read the files this group imports (its require(...) targets) and check the connection — that the dependency
    points one way [LAW:one-way-deps] and that no single fact is defined or owned on both sides [LAW:one-source-of-truth];
    (3) keep it to one or two sentences.

    ${scoutOutputContract(toolNames)}`,
  };
}

module.exports = { buildReviewInput, buildRepoReviewInput, buildPrScoutInput, buildRepoScoutInput };
