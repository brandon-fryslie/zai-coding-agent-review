'use strict';
// [LAW:one-way-deps] diff.js depends on review.js for the ONE definition of a vertical separator and
// the ONE collapser built from it; review.js requires nothing, so the arrow points downhill and no
// cycle exists.
const { hasVerticalSeparator, flattenBody } = require('./review');

function matchesPattern(filename, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\x00/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  const basename = filename.split('/').pop();
  return regex.test(filename) || regex.test(basename);
}

// [LAW:types-are-the-program] Nothing was excluded, as a VALUE — the honest material of a review no
// pattern filtered (scripts/local-review.js, and the anchor-only prompt build). Frozen because it is
// shared: a mutation here would rewrite what every other caller believes about its own run.
const NO_EXCLUSIONS = Object.freeze({ patterns: [], paths: [] });

// [LAW:types-are-the-program] Filtering produces TWO halves and one fact about the cut, so it returns
// both: `reviewed` — what the review may see — and `excluded`, the patterns that fired paired with the
// paths they removed. The pairing is the type's job, not a convention: no call site can hand one filter
// run's patterns to another run's paths. [LAW:one-source-of-truth] the removed set is recorded HERE,
// where it is known, so the prompt that must confess the gap (buildReviewInput) reads it as a value
// rather than re-globbing the patterns — a second, drifting answer to "what did we hide?" — or
// recovering a lossy count by subtracting list lengths, which is what run.js used to do.
function filterFiles(files, excludePatterns) {
  const isExcluded = f => excludePatterns.some(p => matchesPattern(f.filename, p));
  return {
    reviewed: files.filter(f => !isExcluded(f)),
    // Every configured pattern, not only the ones that matched: the reviewer's question is "is this
    // path's absence explained by configuration?", and a pattern that removed nothing still answers it
    // for a file that simply never changed. `paths` alone decides whether anything was hidden at all.
    excluded: { patterns: excludePatterns, paths: files.filter(isExcluded).map(f => f.filename) },
  };
}

// The prose extensions, as a closed set. This is a BLACKLIST of prose and deliberately not a whitelist of
// code: the set of code extensions is open and grows with every language a consumer adopts, so a whitelist
// silently withholds a review the day someone adds a `.zig` file, and withholding is the failure that
// cannot be seen from the run. Anything unrecognized is therefore code and gets reviewed — the same safe
// direction parseReviewableFiles takes at its own boundary. [LAW:no-silent-failure]
const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

// A leading dot is an extensionless dotfile (`.md` as a whole filename), not a prose extension — `dot > 0`
// keeps it on the code side, again the safe direction.
function isProse(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 && PROSE_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

// [LAW:single-enforcer] The ONE answer to "is there anything in this changed set worth spawning an engine
// for?", asked by the pre-spawn gate in runPrReview and nowhere else.
//
// The empty set is not special-cased: `[].every(...)` is already true, so "nothing changed", "EXCLUDE_PATTERNS
// removed everything", "every path was refused at the diff boundary", and "this PR is prose only" are one
// value reaching one gate, not four branches. [LAW:dataflow-not-control-flow]
//
// Prose accompanying code is NOT withheld — a README beside a source change still reaches the engine,
// because `every` is false the moment one code file is present. Only the prose-ONLY change skips the spend.
function noCodeToReview(files) {
  return files.every(f => isProse(f.filename));
}

// [LAW:one-source-of-truth] The one way a withheld set is displayed, wherever it is displayed — the scout
// prompt, every worker and sweep prompt, the operator log, and the plan-boundary warning. It lives here,
// beside the record it renders, because "how long may this list be?" is a property of showing a withheld
// set and not of any one sink; restating it per sink is how two sinks acquire two truncation contracts.
// It is BOUNDED: a PR that bumps a large vendored tree removes thousands of changed files, and in the
// prompt this list is paid on every engine spawn. Twenty names the ordinary case (build output,
// lockfiles) in full; beyond that the remainder is STATED rather than dropped — a truncated list that
// lied about its own length would be the same withheld-information defect one level down, which is the
// exact defect this whole mechanism exists to remove. [LAW:no-silent-failure]
// One cap for every sink, deliberately. A per-sink limit would buy an operator paths 21–100 at the price
// of two numbers to reason about, and the patterns plus the count already say how to find them; the token
// cost is why the bound is 20 rather than 200, never why a bound exists.
// No flatten: these paths crossed parseReviewableFiles BEFORE filterFiles ever saw them, so every one is
// already single-line and byte-exact — a path that could break out of this line was refused at that
// boundary rather than collapsed here.
const MAX_EXCLUDED_PATHS_SHOWN = 20;
function excludedPathList(paths) {
  const shown = paths.slice(0, MAX_EXCLUDED_PATHS_SHOWN);
  const more = paths.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}`;
}

// [LAW:one-source-of-truth] The new-file line number is the one honest anchor for a
// changed line; both GitHub (line+side) and Gitea (new_position) speak it natively.
// Each hunk header resets the new-side counter; only added/context lines advance it
// and are anchorable (deletions have no new-side line).
function* patchLines(patch) {
  let newLine = 0;
  let inHunk = false;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      yield { kind: 'meta', text };
      continue;
    }
    // Inside a hunk the first char classifies the line (+ added, ' ' context, - deletion,
    // '\' the no-newline marker). A blank source line's context marker is a bare ' '; a host
    // that strips trailing whitespace delivers it as '' — the one reading a well-formed patch
    // allows, since it never carries a bare empty line inside a hunk. Restore the canonical
    // ' ' so a stripped context line still advances the new-side counter, instead of silently
    // desyncing every following anchor by one. [LAW:no-silent-failure] [FRAMING:representation]
    const marker = inHunk ? (text === '' ? ' ' : text[0]) : undefined;
    if (marker === '+' || marker === ' ') {
      yield { kind: 'line', line: newLine, text };
      newLine++;
      continue;
    }
    yield { kind: 'meta', text };
  }
}

function buildFileAnchors(file) {
  const anchors = new Map();
  for (const entry of patchLines(file.patch)) {
    if (entry.kind === 'line') {
      anchors.set(`${file.filename}:${entry.line}`, { path: file.filename, line: entry.line });
    }
  }
  return anchors;
}

function buildReviewAnchors(files) {
  return new Map(files.filter(f => f.patch).flatMap(f => [...buildFileAnchors(f)]));
}

// [LAW:effects-at-boundaries] Pure. CHURN — the count of changed content lines (added + deleted)
// across the reviewed files' patches. This is the `diffSize` axis the budget cost estimate is
// calibrated against (src/budget.js), computed over the SAME filtered file set the engine reviews so
// excluded files (dist/**, lockfiles) never inflate the estimate. A patch body runs from its first
// `@@` onward, so a leading '+'/'-' is an added/deleted content line; the hunk header (`@@`) and the
// no-newline marker ('\') start with neither. A file with no patch (binary/rename-only) contributes 0.
function diffChurn(files) {
  let churn = 0;
  for (const file of files) {
    if (!file.patch) continue;
    for (const line of file.patch.split('\n')) {
      if (line[0] === '+' || line[0] === '-') churn++;
    }
  }
  return churn;
}

function annotatePatchWithLines(patch) {
  const lines = [];
  for (const entry of patchLines(patch)) {
    lines.push(entry.kind === 'line' ? `LINE ${entry.line}: ${entry.text}` : entry.text);
  }
  return lines.join('\n');
}

// Git prints a path double-quoted with C-style escapes when it holds a byte that needs
// quoting (a control char, a `"`/`\`, or — by default — any byte >= 0x80, i.e. non-ASCII).
// Reverse that encoding to recover the real filename. Octal escapes carry raw UTF-8 bytes
// (é -> \303\251), so accumulate a byte stream and decode it as UTF-8 once at the end;
// decoding each octal as its own code point would yield mojibake — a wrong filename that
// would itself mis-anchor. [FRAMING:representation]
const C_ESCAPE_BYTE = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
function unquoteCStylePath(inner) {
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') {
      for (const b of Buffer.from(inner[i], 'utf8')) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next >= '0' && next <= '7') {
      let oct = '';
      while (oct.length < 3 && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
        oct += inner[i + 1];
        i++;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      continue;
    }
    const mapped = C_ESCAPE_BYTE[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i++;
    } else {
      // Lone/unknown backslash (git never emits one): keep it literal, reprocess `next`.
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// The b-side path of a `diff --git` header, honoring git's quoted form. Returns null when
// the header is malformed FOR US so the caller owns no file rather than the wrong one.
// [LAW:no-silent-failure]
function parseGitDiffHeader(line) {
  const quotedB = /^diff --git .+ "b\/((?:[^"\\]|\\.)*)"$/.exec(line);
  if (quotedB) return unquoteCStylePath(quotedB[1]);
  const plainB = /^diff --git a\/.+ b\/(.+)$/.exec(line);
  if (plainB) return plainB[1];
  return null;
}

// Parse a unified diff into the same {filename, status, patch} shape GitHub's listFiles
// returns (where `patch` is the hunk text from the first @@ onward), plus the warnings the
// caller must surface. Returns { files, warnings }.
function parseUnifiedDiff(diff) {
  const files = [];
  const warnings = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.hunks.length > 0) {
      files.push({ filename: cur.filename, status: cur.status, patch: cur.hunks.join('\n') });
    }
  };
  for (const line of diff.split('\n')) {
    // Every file section opens with `diff --git `; treat that prefix as the file boundary
    // structurally, so a header we cannot parse still closes the previous file (cur=null)
    // instead of silently bleeding its hunks into the wrong one — which would falsify
    // patchLines' anchors for both files at once. [LAW:no-silent-failure] [LAW:one-source-of-truth]
    if (line.startsWith('diff --git ')) {
      flush();
      const filename = parseGitDiffHeader(line);
      if (filename === null) {
        warnings.push(`parseUnifiedDiff: unparseable diff header; its hunks are dropped rather than attributed to the previous file: ${line}`);
      }
      cur = filename === null ? null : { filename, status: 'modified', hunks: [], inHunk: false };
      continue;
    }
    if (!cur) {
      continue;
    }
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'removed';
    else if (line.startsWith('rename to ')) cur.status = 'renamed';
    if (/^@@ /.test(line)) cur.inHunk = true;
    if (cur.inHunk) cur.hunks.push(line);
  }
  flush();
  return { files, warnings };
}

// [LAW:parse-dont-validate] The boundary that turns a raw host/diff file list into REVIEWABLE files.
// A changed path can legally embed a vertical separator — git C-quotes it in the diff header and
// unquoteCStylePath faithfully reconstructs it — but every representation downstream of here is
// line-structured: a `### path` prompt heading, a `> - path` read-target bullet, a report bullet, a
// GitHub comment anchor. There is no lossless way to put such a path on one of those lines.
//
// The previous design collapsed the separator at each sink, which is strictly worse than refusing it:
// the collapsed path names a file that does not exist, so the worker instructed to open it reads
// nothing and that file's review coverage disappears with no error anywhere. [LAW:no-silent-failure]
// So the path is REFUSED here instead, once, and surfaced as a typed `unreviewable` entry the caller
// reports. Every file that survives this boundary provably renders on one line, which is why no sink
// downstream flattens a filename.
// The accept/reject table this boundary implements — written before the predicate, because a predicate
// written first rejects the shape its author had in mind and silently ADMITS every shape they did not:
//   "src/a.js"          -> reviewable
//   "src/my file.js"    -> reviewable (interior spaces are fine; only VERTICAL separators break a line)
//   "src/a\nEVIL.js"    -> refused (separator: \n, lone \r, U+2028/U+2029)
//   ""  /  "   "        -> refused (no path to open or anchor to)
//   undefined/null/42   -> refused (a non-string has no path at all — it renders as "undefined")
// The last row is not hypothetical pedantry: hasVerticalSeparator(undefined) coerces to the STRING
// "undefined", finds no separator, and would wave it through as a reviewable file.
function reviewablePathRefusal(filename) {
  if (typeof filename !== 'string') return `path is ${filename === null ? 'null' : typeof filename}, not a string`;
  if (filename.trim().length === 0) return 'path is blank';
  if (hasVerticalSeparator(filename)) return 'path contains a line separator, so it cannot be named on a prompt line or anchored to a review comment';
  return null;
}

// [LAW:parse-dont-validate] A refusal record names the refused path in the ONE form every sink can
// render: JSON-quoted — so a non-string, a blank, and an embedded \n are each visible and distinct
// rather than collapsing into a plausible-looking path — then flattened, because JSON.stringify leaves
// U+2028/U+2029 raw and those are line separators too. The RAW value is deliberately not carried: it is
// refused precisely because nothing downstream can open it, anchor to it, or print it, so a displayable
// name is the only honest thing to hand a sink. [LAW:one-source-of-truth] one stamp here, so the run-log
// warning and the posted review body cannot render the same refusal two different ways.
function refusedPathLabel(filename) {
  return flattenBody(JSON.stringify(String(filename)));
}

function parseReviewableFiles(files) {
  const reviewable = [];
  const unreviewable = [];
  for (const file of files) {
    const refusal = reviewablePathRefusal(file.filename);
    if (refusal === null) {
      reviewable.push(file);
      continue;
    }
    unreviewable.push({ filename: refusedPathLabel(file.filename), reason: refusal });
  }
  return { files: reviewable, unreviewable };
}

module.exports = {
  matchesPattern,
  parseReviewableFiles,
  filterFiles,
  noCodeToReview,
  NO_EXCLUSIONS,
  excludedPathList,
  MAX_EXCLUDED_PATHS_SHOWN,
  patchLines,
  buildFileAnchors,
  buildReviewAnchors,
  diffChurn,
  annotatePatchWithLines,
  unquoteCStylePath,
  parseGitDiffHeader,
  parseUnifiedDiff,
};
