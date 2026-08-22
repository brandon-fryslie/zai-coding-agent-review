'use strict';

// [LAW:one-source-of-truth] The legal severity range, spelled ONCE. The enforcing parser below and the
// collector tool's advertised JSON schema (src/collector-server.js) both derive from these, so the
// bound the model is told about and the bound the host actually enforces cannot drift apart — a drift
// that would either reject a value the schema invited or accept one it forbade. [LAW:single-enforcer]
const SEVERITY_MIN = 1;
const SEVERITY_MAX = 5;

// [LAW:decomposition] The single per-finding validator: one job — turn one raw record into a typed
// finding or throw. Both entry points below call it, each supplying the `label` IT knows names the
// finding's real position (the array index for a batch, the record index for a single finding), so an
// error always identifies the right one. [LAW:single-enforcer] a finding is validated in exactly one
// place; parseReviewValue and parseFindingValue are two callers of this, not two copies of the rule.
function parseOneFinding(finding, label) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    throw new Error(`${label} is not an object.`);
  }
  const pathValue = finding.path;
  const line = finding.line;
  const body = finding.body;
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    throw new Error(`${label} has an invalid path.`);
  }
  if (!Number.isInteger(line) || line <= 0) {
    throw new Error(`${label} has an invalid line.`);
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error(`${label} has an invalid body.`);
  }
  // [LAW:types-are-the-program] severity is a required integer priority label, 1 (trivial — a comment
  // typo that doesn't impair meaning) to 5 (ships a defect). It is PRIORITY for the author, never a
  // gate: the verdict counts findings, not severities — the blocking/advisory tier was deleted
  // deliberately because the model's non-blocking judgment was not trustworthy, and this label must
  // never grow back into one.
  const severity = finding.severity;
  if (!Number.isInteger(severity) || severity < SEVERITY_MIN || severity > SEVERITY_MAX) {
    throw new Error(`${label} has an invalid severity (expected an integer ${SEVERITY_MIN}-${SEVERITY_MAX}).`);
  }
  // [LAW:parse-dont-validate] `path` is stamped single-line HERE, at the one boundary that produces a
  // finding, so no sink downstream has to remember to flatten it. `body` is deliberately NOT stamped:
  // it is genuinely block text (an inline PR comment renders paragraphs, and partitionFindings appends
  // a "\n\n_(Anchored to line N…)_" note), so its line-structured sinks render it through
  // findingLineText — the one place that flattens a body. [LAW:one-type-per-behavior]
  return { path: flattenBody(pathValue), line, body: body.trim(), severity };
}

function parseReviewValue(parsed, context) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${context} has the wrong shape.`);
  }

  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error(`${context} must include a non-empty summary.`);
  }
  // [LAW:parse-dont-validate] A spawn's summary is a single-line value in every sink that consumes it —
  // composeSummary's `**scope** — summary` line, and the scout's summary interpolated as a worker's
  // structural context. Stamping it here is what makes those sinks safe by construction rather than by
  // each remembering to flatten a model-authored string. [LAW:single-enforcer]
  const summary = flattenBody(parsed.summary);
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`${context} must include a findings array.`);
  }

  const findings = parsed.findings.map((finding, index) =>
    parseOneFinding(finding, `Review collector finding ${index + 1}`));

  return { summary, findings };
}

function parseFindingValue(finding, index) {
  return parseOneFinding(finding, `Review collector finding ${index + 1}`);
}

// [LAW:types-are-the-program] A scout's scope is the same kind of typed, schema-validated record as a
// finding — a name + focus (both non-empty strings) plus the changed files this scope owns. It is
// recorded through the collector tool (never parsed from the model's prose), so an empty or malformed
// scope is rejected here at the one boundary, exactly as a finding is. [LAW:single-enforcer]
//
// `files` is the scope's changed-file assignment: in PR mode every changed file belongs to exactly one
// scope and its worker reads those files in full (the read cost is thus split across workers, not
// duplicated). It is OPTIONAL because the whole-repo scout has no diff to partition — an absent or
// non-array files is a clean empty list, so a repo scope (or a PR scope the model left unlisted) carries
// []. Non-string / blank entries are dropped so a sloppy list can't inject an empty path. [LAW:no-silent-failure]
function parseScopeValue(scope, index) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error(`Review collector scope ${index + 1} is not an object.`);
  }
  const name = scope.name;
  const focus = scope.focus;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`Review collector scope ${index + 1} has an invalid name.`);
  }
  if (typeof focus !== 'string' || focus.trim().length === 0) {
    throw new Error(`Review collector scope ${index + 1} ('${name.trim()}') has an invalid focus.`);
  }
  // [LAW:parse-dont-validate] name, focus and every file entry are stamped single-line here. All three
  // reach line-structured sinks — the aggregated summary's scope list, the worker prompt's CONCENTRATE
  // block (via workerFocusText), the read-targets line — and all three are MODEL-AUTHORED, so an
  // unstamped one puts attacker-steerable text at column 0 of a prompt, where a continuation line reads
  // as an instruction rather than as data. Stamping at the single boundary that produces a scope is what
  // makes every one of those sinks safe without any of them checking. [LAW:single-enforcer]
  const files = Array.isArray(scope.files)
    ? scope.files.filter(f => typeof f === 'string' && f.trim().length > 0).map(f => flattenBody(f))
    : [];
  return { name: flattenBody(name), focus: flattenBody(focus), files };
}

// [LAW:types-are-the-program] A dependency assessment is the same kind of typed, schema-validated
// record as a finding or a scope: the model's per-module judgment about a resolved go.mod bump, recorded
// through the assess_dependency collector tool (never parsed from prose). The HOST owns every structural
// fact — module, from→to, magnitude, and the compare/commit/release links — so this record carries ONLY
// what the host cannot derive: the model's judgment. [LAW:one-source-of-truth]
//   - module: which bump this judges (matched back to a host-owned summary by exact module path).
//   - impact: the one-line synthesis of what materially changed upstream — the headline, not a commit dump.
//   - affected: does THIS repo's own usage break/change? A required boolean, so "we didn't check" can never
//     masquerade as "not affected" — the model must commit to a call. [LAW:no-silent-failure]
//   - callSite: where, when affected. Optional string: a genuine domain optional (there is no call site to
//     name when affected is false), so its absence is a value the renderer handles, not a guard. When
//     affected is true it SHOULD be named; a missing one degrades to an explicit "(call site not named)"
//     rather than failing the whole review. [LAW:no-defensive-null-guards]
//   - verdict: the merge-risk call, a closed enum — it owns its glyph and action string at the one render
//     site. The verdict is PRESENTATION; the actual merge gate stays driven by findings (every finding
//     blocks), so a lenient verdict can never silently downgrade a real blocker. [LAW:single-enforcer]
const ASSESSMENT_VERDICTS = ['safe', 'review', 'risky'];

function parseAssessmentValue(assessment, index) {
  if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
    throw new Error(`Review collector assessment ${index + 1} is not an object.`);
  }
  const module = assessment.module;
  if (typeof module !== 'string' || module.trim().length === 0) {
    throw new Error(`Review collector assessment ${index + 1} has an invalid module.`);
  }
  const impact = assessment.impact;
  if (typeof impact !== 'string' || impact.trim().length === 0) {
    throw new Error(`Review collector assessment ${index + 1} ('${module.trim()}') has an invalid impact.`);
  }
  if (typeof assessment.affected !== 'boolean') {
    throw new Error(`Review collector assessment ${index + 1} ('${module.trim()}') has an invalid affected (expected boolean).`);
  }
  const verdict = assessment.verdict;
  if (!ASSESSMENT_VERDICTS.includes(verdict)) {
    throw new Error(`Review collector assessment ${index + 1} ('${module.trim()}') has an invalid verdict (expected ${ASSESSMENT_VERDICTS.map(v => `'${v}'`).join(', ')}).`);
  }
  // callSite is a genuine optional: absent/blank collapses to null (no call site to name), a value the
  // renderer handles — never a guard skipping work. [LAW:no-defensive-null-guards]
  const callSite = typeof assessment.callSite === 'string' && assessment.callSite.trim().length > 0
    ? flattenBody(assessment.callSite)
    : null;
  // [LAW:parse-dont-validate] module, impact and callSite are stamped single-line here: every one of
  // them renders as part of a bullet in the posted review's dependency section AND in the worker
  // prompt's dependency note, both line-structured. dedupeAssessments also keys on `module`, so
  // stamping it at the boundary keeps one module from splitting into two records over a stray
  // separator. [LAW:single-enforcer]
  return { module: flattenBody(module), impact: flattenBody(impact), affected: assessment.affected, callSite, verdict };
}

// [LAW:one-source-of-truth] "The same assessed module": keyed on the module path alone — a module is
// assessed once. The dependency note reaches every worker, but the assess directive is gated to the ONE
// worker that owns the bumped go.mod (buildReviewInput), so single authorship is the common case; this is
// the safety net for the multi-go.mod PR (several workers each own a go.mod) and any model over-eagerness.
//
// [LAW:no-ambient-temporal-coupling] Conflict resolution: two workers assessing one module with different
// verdicts must not let arrival order (nondeterministic under concurrency) pick the winner.
// The MORE CAUTIOUS verdict wins — a masked 'safe' over a real 'risky' would mislead the reader even though
// the merge gate is findings-driven. ASSESSMENT_VERDICTS is ordered by ascending caution, so its index IS
// the caution rank — no second table to drift. [LAW:one-source-of-truth] First-seen position is preserved
// (a Map keeps a key's original slot when its value is replaced), matching dedupeFindings.
function dedupeAssessments(assessments) {
  const caution = a => ASSESSMENT_VERDICTS.indexOf(a.verdict);
  const byModule = new Map();
  for (const a of assessments) {
    const existing = byModule.get(a.module);
    if (!existing || caution(a) > caution(existing)) byModule.set(a.module, a);
  }
  return [...byModule.values()];
}

// [LAW:one-source-of-truth] The single definition of "the same recorded finding, up to wording": a
// body normalized by collapsing whitespace and lowercasing. Both dedup sites — the pre-anchor merge of
// worker findings (dedupeFindings) and the post-anchor collapse of findings that snapped to one line
// (partitionFindings) — derive their key from THIS, never re-authoring the normalization. [LAW:single-enforcer]
function normalizeBody(body) {
  return (body || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// [LAW:effects-at-boundaries] Pure: one dedup pass over a set of findings. This is the single place
// "same finding" is decided; every downstream sink consumes this deduped list and never re-derives the
// key. [LAW:single-enforcer] [LAW:one-type-per-behavior] It is called at two lifecycle points on the
// same behavior — merging worker findings before anchoring, and collapsing findings that SNAP onto one
// line after anchoring — so it is one function, not two copies.
//
// [FRAMING:representation] The key must be an HONEST representation of "the same recorded finding". A
// body PREFIX lied in both directions: the prompt mandates every body open with a category tag ("Bug,
// Edge case, …"), so two DISTINCT findings on one line systematically shared a 60-char prefix and the
// second was silently dropped — a recorded finding lost after collection. [LAW:no-silent-failure] So key
// on the FULL body, normalized, so byte-for-byte re-records — the real double-record case — still
// collapse, while any genuine difference in wording keeps two findings apart. Cross-worker paraphrases
// of one issue surviving as near-duplicates is noise, not loss — the accepted direction to err.
//
// [LAW:no-silent-failure] Severity is the author's priority signal, so a duplicate must never lose it
// to arrival order (nondeterministic under concurrent workers — [LAW:no-ambient-temporal-coupling]):
// when two members share a key, the merged finding carries the HIGHEST severity of the group, never
// the one that happened to arrive first. First-seen order is preserved (a Map keeps a key's original
// position when its value is replaced).
//
// Which MEMBER survives is a separate preference: a candidate mid-anchoring may carry snappedFromLine
// (partitionFindings scaffolding — the finding cited a line just outside the diff and was snapped).
// An exact-anchored member (no snappedFromLine) outranks a snapped one regardless of arrival order,
// so a finding also recorded exactly on the anchor line is never presented with a stale
// "referenced line M, just outside the diff" note. Pre-anchor callers (multiscope) carry no
// snappedFromLine on any member, so for them this preference is vacuously first-seen.
function dedupeFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.path}:${f.line}:${normalizeBody(f.body)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, f);
      continue;
    }
    const severity = Math.max(existing.severity, f.severity);
    const exactBeatsSnapped = existing.snappedFromLine !== undefined && f.snappedFromLine === undefined;
    byKey.set(key, exactBeatsSnapped ? { ...f, severity } : { ...existing, severity });
  }
  return [...byKey.values()];
}

// A finding cited a line within this many lines of a real anchorable line is snapped to
// that line rather than dropped: the model named a line just outside the diff hunk, but the
// comment body is specific enough that a small offset still lands on the right change and the
// reader can place it. Beyond this window the line reference is too far off to trust, so the
// finding is surfaced in the summary instead. [LAW:no-mode-explosion] one documented constant.
const MAX_ANCHOR_SNAP_DISTANCE = 10;

// [LAW:effects-at-boundaries] Pure: given a cited line and the anchorable lines for its file,
// return the nearest line within the snap window, or null when none is close enough.
function nearestAnchorableLine(line, fileLines) {
  if (!fileLines || fileLines.length === 0) return null;
  let best = fileLines[0];
  for (const candidate of fileLines) {
    if (Math.abs(candidate - line) < Math.abs(best - line)) best = candidate;
  }
  return Math.abs(best - line) <= MAX_ANCHOR_SNAP_DISTANCE ? best : null;
}

// [LAW:single-enforcer] partitionFindings is the one place that reconciles model findings
// with the visible diff anchors; nothing else re-implements this check.
// [LAW:dataflow-not-control-flow] The reconciliation is a value, not a throw: a finding the
// model anchored outside the diff is not a fatal error that aborts the whole review (which
// would discard every valid finding and red the run). Each finding flows to exactly one of:
//   - anchored: already on the grid, or snapped to the nearest reviewed line (body annotated
//     so the adjustment is explicit — [LAW:no-silent-failure]).
//   - unanchored: too far from any reviewed line; the caller surfaces it in the summary and
//     logs it, never silently dropping it.
function partitionFindings(findings, anchors) {
  const linesByPath = new Map();
  for (const { path, line } of anchors.values()) {
    if (!linesByPath.has(path)) linesByPath.set(path, []);
    linesByPath.get(path).push(line);
  }

  // [LAW:dataflow-not-control-flow] Resolve each finding to a value: an anchored CANDIDATE (original
  // body kept intact, line set to the anchor it lands on) or unanchored. The body is NOT yet annotated
  // — the snap note is a rendering applied last, so it never pollutes the identity the collapse keys on.
  const candidates = [];
  const unanchored = [];
  for (const finding of findings) {
    if (anchors.has(`${finding.path}:${finding.line}`)) {
      candidates.push({ ...finding });
      continue;
    }
    const snapped = nearestAnchorableLine(finding.line, linesByPath.get(finding.path));
    if (snapped === null) {
      unanchored.push(finding);
      continue;
    }
    candidates.push({ ...finding, line: snapped, snappedFromLine: finding.line });
  }

  // [LAW:one-type-per-behavior] Two findings the model recorded on DIFFERENT nearby lines can snap onto
  // one anchor line; keyed on path:line:normalizeBody they are now the same recorded finding, so the
  // same dedup that merged worker findings collapses them here — one function, run after anchoring.
  // Annotation is applied to survivors ONLY, so the differing pre-snap line in each note can never split
  // the key and defeat the collapse. [LAW:effects-at-boundaries] snappedFromLine is scaffolding internal
  // to this function; it is stripped as the note is rendered and never leaves.
  const anchored = dedupeFindings(candidates).map(({ snappedFromLine, ...finding }) =>
    snappedFromLine === undefined
      ? finding
      : {
        ...finding,
        body: `${finding.body}\n\n_(Anchored to line ${finding.line}; the review referenced line ${snappedFromLine}, just outside the diff.)_`,
      },
  );
  return { anchored, unanchored };
}

// [LAW:one-source-of-truth] The one rendering of a finding's severity label. Every sink that shows a
// finding to a human (inline PR comment, the unanchored summary section, the whole-repo report, the
// convergence-sweep prior list) derives the tag from here rather than restating it. The tag is
// PRESENTATION of the priority value — it never feeds the verdict.
function severityTag(finding) {
  return `**[S${finding.severity}]**`;
}

// [LAW:single-enforcer] The one rendering of a finding as a single line of text. A body is the one
// model-authored field that is legitimately block text — an inline PR comment renders its paragraphs,
// and partitionFindings appends a "\n\n_(Anchored to line N…)_" note — so it is the one field a
// line-structured sink must still collapse. This is that collapse's single owner: the three
// line-structured finding sinks (the posted review's unanchored section, the whole-repo report, the
// convergence-sweep prior list) each compose their own prefix around this and none re-authors the
// tag-plus-flattened-body rule.
function findingLineText(finding) {
  return `${severityTag(finding)} ${flattenBody(finding.body)}`;
}

// [LAW:one-source-of-truth] The one definition of "a vertical separator" — the characters that end a
// line for a Markdown renderer or a prompt reader: \n, a lone \r (a CommonMark line ending,
// reconstructable in a filename via unquoteCStylePath), and U+2028/U+2029. Both consumers below build
// their regex from THIS string, so the set can never drift between the collapser and the detector.
const VERTICAL_SEPARATORS = '\\n\\r\\u2028\\u2029';

// [LAW:single-enforcer] The one rule for collapsing untrusted text to a single line: a continuation
// line at column 0 detaches from its bullet/heading and renders as injected markup — or, in a prompt,
// reads as a stray instruction. It collapses EVERY vertical separator — \n, a lone \r (a CommonMark
// line ending, reconstructable in a filename via unquoteCStylePath), and U+2028/U+2029 — not just \n.
//
// [LAW:parse-dont-validate] This is applied at PARSE BOUNDARIES, not at sinks. Every model-authored
// field whose domain is single-line (a scope's name/focus/files, a spawn's summary, a finding's path,
// an assessment's module/impact/callSite) is stamped as it is parsed, so a sink cannot receive an
// unflattened one and therefore has nothing to check. Sink-side flattening was the previous design and
// it failed the way call-site discipline always fails: `focus` and a worker's `summary` reached
// line-structured sinks raw because two of a dozen call sites were missed. The two remaining callers
// are the ones whose input is NOT single-line by domain: findingLineText (a body is block text) and
// the diff-path reject check (a path must stay byte-exact, so it is refused, never collapsed).
function flattenBody(body) {
  return body.replace(new RegExp(`\\s*[${VERTICAL_SEPARATORS}]\\s*`, 'g'), ' ').trim();
}

// [LAW:one-source-of-truth] The detector and the collapser read the SAME character class, so the set of
// "what counts as a vertical separator" has one definition. A path is refused rather than collapsed
// (see parseReviewableFiles in diff.js): collapsing a path yields a filename that does not exist, so
// the worker told to open it reads nothing and the file's review coverage vanishes silently \u2014 the
// failure this replaces. [LAW:no-silent-failure]
function hasVerticalSeparator(text) {
  return new RegExp(`[${VERTICAL_SEPARATORS}]`).test(text);
}

// [LAW:one-source-of-truth] The subject line of a block of text — everything before its first vertical
// separator — built from the SAME separator class as the collapser and the detector. A hand-rolled
// `.split('\n')[0]` is the same rule spelled a fourth time and a strictly weaker one: it keeps a lone
// \r or a U+2028 and hands the sink a string that still breaks its line.
function firstLine(text) {
  return text.split(new RegExp(`[${VERTICAL_SEPARATORS}]`))[0].trim();
}

// [LAW:single-enforcer] The one rule for rendering untrusted text as a Markdown code span: the
// backtick fence is sized longer than any backtick run inside the content, so the delimiter can never
// be supplied by the data (a backtick-bearing filename or go.mod token cannot close the span early
// and inject markdown). Content must already be newline-free — a code span cannot contain a blank
// line — so callers compose this with flattenBody. [LAW:composability]
function codeSpan(content) {
  const longestRun = (content.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const pad = longestRun > 0 ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

module.exports = { parseReviewValue, parseFindingValue, parseScopeValue, parseAssessmentValue, ASSESSMENT_VERDICTS, SEVERITY_MIN, SEVERITY_MAX, dedupeAssessments, normalizeBody, dedupeFindings, partitionFindings, nearestAnchorableLine, severityTag, findingLineText, flattenBody, hasVerticalSeparator, firstLine, codeSpan };
