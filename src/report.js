'use strict';

// The printed sink for full-repo review mode. There is no pull request to comment on, so
// findings are rendered as a single Markdown report written to the GitHub Step Summary and
// the run log. [LAW:effects-at-boundaries] This renderer is PURE — it returns the report
// string from values; the run boundary owns the actual write. [LAW:decomposition] It mirrors
// transport.submitReview (the PR sink) but produces text instead of a host review.

// Group findings by file path, preserving first-seen path order, lines ascending within a file.
// [LAW:dataflow-not-control-flow] An empty findings array is a value that renders as the
// "No findings" section — not a skipped branch.
function groupByPath(findings) {
  const byPath = new Map();
  for (const finding of findings) {
    if (!byPath.has(finding.path)) byPath.set(finding.path, []);
    byPath.get(finding.path).push(finding);
  }
  for (const list of byPath.values()) {
    list.sort((a, b) => a.line - b.line);
  }
  return byPath;
}

// One finding rendered as a list item; the body is flattened to a single line so the grouped
// list stays scannable in the Step Summary.
function renderFinding(finding) {
  const body = finding.body.replace(/\s*\n\s*/g, ' ').trim();
  return `- **line ${finding.line}:** ${body}`;
}

function renderFindingsSection(findings) {
  if (findings.length === 0) {
    return ['**No findings.**'];
  }
  const lines = [`### Findings (${findings.length})`];
  for (const [path, list] of groupByPath(findings)) {
    lines.push('', `#### ${path}`, ...list.map(renderFinding));
  }
  return lines;
}

// [LAW:effects-at-boundaries] Pure: render the full-repo review report from values. scope is
// free text ('' = whole repository); footer is the already-built attribution + cost line ('' =
// none). The summary is the engine's finish_review summary, carried through unchanged.
function renderRepoReport({ reviewerName, scope, review, footer }) {
  const scopeLine = scope
    ? `**Scope:** ${scope}`
    : '**Scope:** whole repository';
  const lines = [
    `## ${reviewerName} — Full-repository review`,
    '',
    scopeLine,
    '',
    review.summary,
    '',
    ...renderFindingsSection(review.findings),
  ];
  if (footer) {
    lines.push('', footer);
  }
  return lines.join('\n');
}

module.exports = { renderRepoReport, groupByPath };
