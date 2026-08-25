#!/usr/bin/env bash
# Enforce the version-bump rule on a PR. [LAW:single-enforcer]
#
# CLAUDE.md states the rule in prose: "Every PR that changes what consumers run
# bumps the version, in that same PR." Prose is folklore — guarded only by human
# discipline, it is exactly what let package.json drift behind the release tag
# and stranded four merged releases. This script is the machine that enforces it,
# so the invariant has a type, not a hope. [LAW:types-are-the-program]
#
# The verdict is a pure function of two facts about the diff vs the base:
#   1. did the change touch the SHIPPED SURFACE (the bundle a consumer runs)?
#   2. did package.json's version change?
# A shipped-surface change with no bump fails loudly [LAW:no-silent-failure]; a
# docs/scripts/workflow-only change needs no bump and passes — mirroring the
# release.sh no-op rule. [LAW:dataflow-not-control-flow]
#
# It does NOT re-check that dist/ matches a fresh build — ci.yml already owns
# that single enforcer; duplicating it here would be a second source. [LAW:single-enforcer]
#
# Usage: scripts/check-version-bump.sh <base-ref>
#   <base-ref> — what to diff against, e.g. origin/main (the PR's base branch).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

die() { echo "ERROR: $*" >&2; exit 1; }

# Read a package.json's version by reading bytes and parsing as JSON — NOT via
# `require()`, which dispatches on file extension and would parse an extensionless
# temp file as JavaScript. One mechanism for both sides. [LAW:one-type-per-behavior]
pkg_version() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$1"; }

# A bump is a strict semver INCREASE, not merely a change — a downgrade (1.21.2 →
# 1.20.0) is not a bump. [LAW:types-are-the-program] the rule encodes direction.
# Pure-node numeric compare of x.y.z; this project has no semver dependency and its
# versions are strict 1.MINOR.PATCH (release.sh enforces major 1). Exit 0 iff $1 > $2.
version_gt() {
  node -e '
    const a = process.argv[1].split(".").map(Number);
    const b = process.argv[2].split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) process.exit(0);
      if (a[i] < b[i]) process.exit(1);
    }
    process.exit(1);
  ' "$1" "$2"
}

BASE_REF="${1:?usage: check-version-bump.sh <base-ref>}"

# The shipped surface: the files whose change a consumer actually runs (the action
# entry, the bundled code, the runtime reviewer instructions). Defined ONCE, here.
# .github/workflows/, scripts/, test/, docs, and CLAUDE.md are NOT shipped — a
# change confined to them needs no release. [LAW:one-source-of-truth]
# dismiss-block/ is named by its shipped PATHS, not as a directory: the bare entry also matched
# dismiss-block/README.md, forcing a release for a doc edit that the identical edit to the root
# README.md is correctly spared — the same fact answered two ways by where the doc happens to live.
SHIPPED_SURFACE=(src dist action.yml review-agent dismiss-block/action.yml dismiss-block/dist)

mapfile -t CHANGED < <(git diff --name-only "${BASE_REF}...HEAD")

shipped_changed=false
for f in "${CHANGED[@]}"; do
  for p in "${SHIPPED_SURFACE[@]}"; do
    case "$f" in
      "$p"|"$p"/*) shipped_changed=true; break 2 ;;
    esac
  done
done

if ! $shipped_changed; then
  echo "✓ no shipped-surface files changed in this PR; no version bump required."
  exit 0
fi

# package.json is the one source of truth for the version; node is guaranteed
# present in a node project (no jq dependency).
HEAD_VERSION="$(pkg_version ./package.json)"
BASE_PKG="$(mktemp)"
trap 'rm -f "$BASE_PKG"' EXIT
git show "${BASE_REF}:package.json" > "$BASE_PKG" \
  || die "could not read package.json from ${BASE_REF} (is the base ref fetched?)."
BASE_VERSION="$(pkg_version "$BASE_PKG")"

[ -n "$HEAD_VERSION" ] || die "could not read version from package.json on HEAD."
[ -n "$BASE_VERSION" ] || die "could not read version from package.json on ${BASE_REF}."

if ! version_gt "$HEAD_VERSION" "$BASE_VERSION"; then
  die "this PR changes the shipped surface (src/, dist/, action.yml, review-agent/, or \
dismiss-block/action.yml, or dismiss-block/dist) \
but package.json's version (${HEAD_VERSION}) is not greater than the base (${BASE_VERSION}). \
Bump the version (a strict increase) and rebuild dist/ in this PR — see CLAUDE.md, \
'Every PR that changes what consumers run bumps the version'."
fi

echo "✓ shipped surface changed and version was bumped: ${BASE_VERSION} → ${HEAD_VERSION}"
