#!/usr/bin/env bash
#
# freeze-case.sh — freeze one real marker-bearing review into a golden eval case.
#
# A "case" is ONE review round: a single reviewed commit, the exact diff the agent
# saw at that commit, the repo tree at that commit, and the findings it produced.
# Everything here is FROZEN so the case replays identically forever — the head SHA's
# tree is captured as a self-contained tarball (CI cannot fetch sibling private repos,
# and PR refs get garbage-collected), and the diff is saved as a file rather than
# recomputed from a live remote. [LAW:one-source-of-truth] The tree is a tarball, not
# a git bundle, because the runner explores it read-only (Read/Grep/Glob) and takes
# the diff from change.diff — it needs the files, not git history — and a depth-1 git
# bundle is not clonable (its parent is a shallow boundary).
#
# The mechanical outputs are produced here; the finding ANNOTATIONS
# (must-find/nice-to-find/noise + justification) are a human-judgment step done by
# hand afterward — this script writes them as "UNREVIEWED" so an un-annotated case
# is loud, never silently treated as scored. [LAW:no-silent-failure]
#
# This script freezes ONE round. The case's POOLED INVENTORY — eligible findings from
# the PR's other review rounds, tagged with their source reviewId — is likewise a
# hand-curation step done afterward; see eval/README.md ("The pooled inventory, and
# its eligibility rule") for the procedure and the eligibility bar.
#
# Usage:
#   eval/freeze-case.sh <case-name> <owner/repo> <pr-number> <review-id> [exclude-patterns] [produced-by]
#
# Example:
#   eval/freeze-case.sh cc-candybar-150-transcript-perf promptctl/cc-candybar 150 4669719961
#
# Requires: gh (authenticated), git, jq. Run from the repo root.

set -euo pipefail

# --- args ---------------------------------------------------------------------
if [ "$#" -lt 4 ]; then
  echo "usage: $0 <case-name> <owner/repo> <pr-number> <review-id> [exclude-patterns] [produced-by]" >&2
  exit 2
fi
NAME="$1"; REPO="$2"; PR="$3"; REVIEW_ID="$4"

# The default exclude set has ONE source of truth: action.yml's EXCLUDE_PATTERNS
# default. Read it from there rather than hardcoding a copy that would silently drift
# from what the action actually does. [LAW:one-source-of-truth] Resolve the path from
# the script's own location so cwd doesn't matter.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION_YML="$SCRIPT_DIR/../action.yml"
default_exclude() {
  [ -f "$ACTION_YML" ] || { echo "action.yml not found at $ACTION_YML" >&2; return 1; }
  awk '/^  EXCLUDE_PATTERNS:/{f=1} f&&/default:/{sub(/.*default:[ ]*/,""); gsub(/^"|"$/,""); print; exit}' "$ACTION_YML"
}
# The explicit 5th arg overrides (for a source workflow that sets its own patterns).
EXCLUDE="${5:-}"
if [ -z "$EXCLUDE" ]; then
  EXCLUDE="$(default_exclude)" || { echo "FREEZE ERROR: could not read EXCLUDE_PATTERNS default from action.yml" >&2; exit 1; }
  [ -n "$EXCLUDE" ] || { echo "FREEZE ERROR: EXCLUDE_PATTERNS default in action.yml is empty" >&2; exit 1; }
fi

# The replay pin: the action's current default engine, resolved FROM src/provider.js
# rather than copied here — the same reasoning as default_exclude() above, applied to
# the fact next to it. [LAW:one-source-of-truth] These were hand-written literals
# ("deepseek"/"deepseek-v4-pro") until 2026-08, and when 1.42.0 retargeted PROVIDER=auto
# to the subscription they silently kept stamping the dead provider onto every new case,
# so a freshly frozen case was born unreplayable. A literal cannot notice a retarget; a
# derivation cannot miss one.
#
# The pin is still written into case.json as a CONCRETE provider/model, never as 'auto':
# the manifest must record which engine the numbers came from, and a later retarget must
# make the pin check fail loudly rather than quietly move an existing case's baseline.
# [LAW:no-silent-failure]
# node's own stderr is deliberately NOT silenced: if provider.js cannot load, that stack trace is the
# only thing that says why, and the generic message below would replace a located cause with a guess.
# [LAW:no-silent-failure]
default_engine() {
  node -e '
    const { PROVIDERS, PROVIDER_ALIASES } = require("./src/provider");
    const name = PROVIDER_ALIASES.auto;
    process.stdout.write(`${name}\t${PROVIDERS[name].defaultModel}`);
  '
}
ENGINE_TSV="$(cd "$SCRIPT_DIR/.." && default_engine)" \
  || { echo "FREEZE ERROR: could not resolve the action's default engine from src/provider.js" >&2; exit 1; }
PROVIDER="${ENGINE_TSV%%$'\t'*}"
MODEL="${ENGINE_TSV##*$'\t'}"
[ -n "$PROVIDER" ] && [ -n "$MODEL" ] && [ "$PROVIDER" != "$ENGINE_TSV" ] \
  || { echo "FREEZE ERROR: default engine resolved to an unusable value: '$ENGINE_TSV'" >&2; exit 1; }

# Provenance of the GOLDEN REVIEW — a fact about the historical review this case was
# curated from, NOT about the replay pin above. The two coincided when every golden
# review had been produced by the then-current default, and were written as one value
# because of it; they are separate facts and a case frozen from an older review must be
# able to say so. Defaults to the current default engine, which is what a review run
# today was produced by. [FRAMING:representation]
PRODUCED_BY="${6:-auto→$PROVIDER / claude-code / $MODEL}"

CASE_DIR="eval/cases/$NAME"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FREEZE ERROR [$NAME]: $*" >&2; exit 1; }
hex40() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fail "not a 40-hex sha: '$1'"; }

echo "== freezing $NAME ($REPO #$PR review $REVIEW_ID) =="

# --- resolve the reviewed anchor ---------------------------------------------
# headSha = the commit the review anchored to; baseSha = the PR base branch tip.
# The diff is a three-dot base...head, whose merge-base is the branch fork point —
# stable no matter how far the base branch later advanced.
HEAD_SHA="$(gh api "repos/$REPO/pulls/$PR/reviews/$REVIEW_ID" --jq '.commit_id')" \
  || fail "could not read review $REVIEW_ID"
BASE_SHA="$(gh api "repos/$REPO/pulls/$PR" --jq '.base.sha')" \
  || fail "could not read PR $PR"
hex40 "$HEAD_SHA"; hex40 "$BASE_SHA"
echo "  head=$HEAD_SHA base=$BASE_SHA"

REMOTE="https://github.com/$REPO.git"
GIT_AUTH=(-c credential.helper='!gh auth git-credential')

# --- change.diff: the exact material the agent reviewed ----------------------
DIFF_DIR="$WORK/diff"; git init -q "$DIFF_DIR"
git -C "$DIFF_DIR" remote add origin "$REMOTE"
git "${GIT_AUTH[@]}" -C "$DIFF_DIR" fetch -q origin "$BASE_SHA" || fail "fetch base $BASE_SHA failed"
git "${GIT_AUTH[@]}" -C "$DIFF_DIR" fetch -q origin "$HEAD_SHA" || fail "fetch head $HEAD_SHA failed"
git -C "$DIFF_DIR" merge-base "$BASE_SHA" "$HEAD_SHA" >/dev/null \
  || fail "no merge-base between base and head (shallow history?)"
mkdir -p "$CASE_DIR"
CASE_ABS="$(cd "$CASE_DIR" && pwd)"  # git -C resolves output paths relative to its own cwd
git -C "$DIFF_DIR" diff "$BASE_SHA...$HEAD_SHA" > "$CASE_DIR/change.diff" \
  || fail "git diff failed"
[ -s "$CASE_DIR/change.diff" ] || fail "change.diff is empty"
DIFF_FILES="$(grep -c '^diff --git ' "$CASE_DIR/change.diff" || true)"
[ "$DIFF_FILES" -gt 0 ] || fail "change.diff has no file headers"
echo "  change.diff: $DIFF_FILES files, $(wc -l < "$CASE_DIR/change.diff" | tr -d ' ') lines"

# --- repo.tar.gz: the head tree, self-contained (depth-1 fetch, minimal) ------
TREE_DIR="$WORK/tree"; git init -q "$TREE_DIR"
git -C "$TREE_DIR" remote add origin "$REMOTE"
git "${GIT_AUTH[@]}" -C "$TREE_DIR" fetch -q --depth 1 origin "$HEAD_SHA" \
  || fail "shallow fetch head $HEAD_SHA failed"
git -C "$TREE_DIR" archive --format=tar.gz -o "$CASE_ABS/repo.tar.gz" FETCH_HEAD \
  || fail "git archive failed"
# Prove the tarball replays: extract it offline and confirm a non-empty tree.
VERIFY="$WORK/verify"; mkdir -p "$VERIFY"
tar -xzf "$CASE_ABS/repo.tar.gz" -C "$VERIFY" || fail "tarball does not extract"
TREE_FILES="$(find "$VERIFY" -type f | wc -l | tr -d ' ')"
[ "$TREE_FILES" -gt 0 ] || fail "tarball tree is empty at head"
echo "  repo.tar.gz: $(du -h "$CASE_ABS/repo.tar.gz" | cut -f1), $TREE_FILES files at head"

# --- expected.json: the finding inventory (annotations UNREVIEWED) ------------
# Slurp all comment pages, keep only this review's inline findings. Anchor to the
# reviewed side/line via original_* (a dismissed review nulls the live line/commit).
COMMENTS="$WORK/comments.json"
gh api --paginate "repos/$REPO/pulls/$PR/comments" --jq '.[]' | jq -s '.' > "$COMMENTS" \
  || fail "could not read PR comments"
N_FINDINGS="$(jq --argjson r "$REVIEW_ID" '[.[] | select(.pull_request_review_id == $r)] | length' "$COMMENTS")"
[ "$N_FINDINGS" -gt 0 ] || fail "no inline findings for review $REVIEW_ID"

jq --argjson r "$REVIEW_ID" --arg head "$HEAD_SHA" '{
  reviewId: $r,
  headSha: $head,
  findings: [ .[] | select(.pull_request_review_id == $r) | {
    commentId: .id,
    path: .path,
    line: (.original_line // .line),
    side: .side,
    annotation: "UNREVIEWED",
    justification: "",
    diffHunk: .diff_hunk,
    body: .body
  } ]
}' "$COMMENTS" > "$CASE_DIR/expected.json" || fail "building expected.json failed"

# Assert the frozen diff and the findings are consistent: each finding's diffHunk body
# (the lines after the @@ header — GitHub sometimes decorates the header with a section
# heading git does not) must be a verbatim substring of change.diff. This makes the
# anchors↔diff invariant a checked property of every case, not a hand-verified hope.
# [LAW:verifiable-goals] jq --rawfile loads the diff as a string; no shell escaping.
UNMATCHED="$(jq -r --rawfile diff "$CASE_DIR/change.diff" '
  [ .findings[]
    | (.diffHunk | split("\n")[1:] | join("\n")) as $body
    | select($body != "" and (($diff | contains($body)) | not))
    | "\(.path):\(.line)"
  ] | .[]' "$CASE_DIR/expected.json")"
[ -z "$UNMATCHED" ] || fail "diffHunk not found in change.diff for: $UNMATCHED"
echo "  expected.json: $N_FINDINGS findings (annotation=UNREVIEWED), diffHunks verified ⊂ change.diff"

# --- case.json: the manifest (single source of truth for identity) -----------
jq -n \
  --arg name "$NAME" --arg repo "$REPO" --argjson pr "$PR" --argjson rev "$REVIEW_ID" \
  --arg head "$HEAD_SHA" --arg base "$BASE_SHA" \
  --arg provider "$PROVIDER" --arg model "$MODEL" --arg exclude "$EXCLUDE" \
  --arg producedBy "$PRODUCED_BY" '{
  name: $name,
  source: { repo: $repo, pr: $pr, reviewId: $rev, headSha: $head, baseSha: $base },
  diff: "change.diff",
  tree: "repo.tar.gz",
  expected: "expected.json",
  engine: { provider: $provider, model: $model, reasoning: null },
  excludePatterns: ($exclude | split(",")),
  producedBy: $producedBy
}' > "$CASE_DIR/case.json" || fail "building case.json failed"

echo "== froze $NAME -> $CASE_DIR (annotate expected.json by hand) =="
