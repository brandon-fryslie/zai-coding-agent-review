# Review-quality eval harness — golden cases

This directory is the **ground truth** for the review-quality eval harness
(`copirate-eval-harness-2fk`): a frozen set of real, high-finding reviews the agent
produced against real PRs, so a future engine change can be replayed against them and
scored for whether it still finds the known good findings. The goal is to make *"did
this prompt/spawn/effort change degrade finding quality?"* a **measured verdict**, not
a guess.

Everything under `eval/` is dev-only tooling (like `scripts/`) — it is **not** part of
the shipped action surface (`src/`, `action.yml`, `review-agent/`, `dist/`), so
changes here **do not bump the version**.

## What a "case" is

One case = **one review round**: a single reviewed commit, the exact diff the agent saw
at that commit, the repo tree at that commit, and the findings it produced — all
**frozen** so the case replays identically forever. A PR that was re-reviewed across
several pushes yields one case per round; each case here freezes the single richest
round of its PR (see the table below).

The design mirrors the one production and `scripts/local-review.js` already use: a case
is *frozen inputs* (repo tree + saved diff + a pinned engine), and the only variance
left at replay time is the model's own stochasticity — handled downstream by N repeats
and a variance band (`copirate-eval-harness-2fk.4`).

### Why the tree is frozen, not referenced

The reviewed commits are **intermediate PR commits** (not the merged head), and PR refs
get garbage-collected after branch deletion. CI's `GITHUB_TOKEN` also cannot read the
sibling `promptctl/*` repos these cases come from. So each case carries its repo tree as
a **self-contained `repo.tar.gz`** — immune to GC, repo moves, and cross-repo auth. It
is a tarball (not a git bundle) because the runner explores the tree read-only
(`Read`/`Grep`/`Glob`) and takes the diff from `change.diff`; it needs the *files*, not
git history, and a depth-1 git bundle is not clonable.

## Directory layout

```
eval/cases/<case-name>/
  case.json      — the manifest: source identity + engine pin (single source of truth)
  change.diff    — the exact unified diff the agent reviewed (base...head, three-dot)
  repo.tar.gz    — the repo tree at the reviewed head SHA, self-contained
  expected.json  — the annotated finding inventory (the ground truth to score against)
```

### `case.json`

| field             | meaning                                                                    |
|-------------------|----------------------------------------------------------------------------|
| `name`            | case dir name                                                              |
| `source.repo`     | `owner/repo` the review ran against                                        |
| `source.pr`       | PR number                                                                  |
| `source.reviewId` | the marker-bearing review whose findings are frozen                        |
| `source.headSha`  | the commit the review anchored to (the tree in `repo.tar.gz`)             |
| `source.baseSha`  | the PR base tip; `change.diff` is `baseSha...headSha` (three-dot)          |
| `diff`            | `"change.diff"`                                                            |
| `tree`            | `"repo.tar.gz"`                                                            |
| `expected`        | `"expected.json"`                                                          |
| `engine`          | pinned `{ provider, model, reasoning }` the replay must use                |
| `excludePatterns` | the source workflow's `EXCLUDE_PATTERNS` (so the replay matches conditions)|
| `producedBy`      | provenance: the config that originally produced the golden review          |

The engine is pinned explicitly (currently `deepseek` / `deepseek-v4-pro`, the action's
default and the config that produced every golden review) so a later change to the
default cannot silently move the baseline. `[LAW:no-silent-failure]`

### `expected.json`

```
{ "reviewId": <n>, "headSha": "<sha>", "findings": [ <finding>, ... ] }
```

Each finding:

| field          | meaning                                                                   |
|----------------|---------------------------------------------------------------------------|
| `commentId`    | the GitHub review-comment id (provenance back to the source PR)           |
| `path`         | file the finding anchors to                                               |
| `line`         | new-file line (the reviewed anchor; `original_line` on a dismissed review)|
| `side`         | diff side, always `RIGHT`                                                  |
| `annotation`   | `must-find` \| `nice-to-find` \| `noise` (see below)                       |
| `justification`| written rationale for the annotation                                       |
| `diffHunk`     | the exact hunk GitHub anchored the comment to (kept for matching)          |
| `body`         | the verbatim finding text the agent posted                                |

Every finding's `diffHunk` body is a **verbatim substring of `change.diff`** — verified
at freeze time, so the anchors and the frozen diff are guaranteed consistent.

## The annotation vocabulary

The scorer (`copirate-eval-harness-2fk.3`) computes **must-find recall** as the primary
metric, with noise count and cost secondary. The annotation defines which bucket a
finding is:

- **`must-find`** — a real bug or subtle architectural catch whose loss would mean
  degradation. This is deliberately the set of **hard, high-value** findings most at
  risk when tokens/effort are cut (a resource leak, a silent-failure classification, an
  aliasing heisenbug, a subtle concurrency coupling), *not* just the obvious ones.
  Recall over this set is what the harness protects.
- **`nice-to-find`** — a legitimate quality/test/doc/perf finding that adds value but
  whose loss is not degradation. Overlapping nice-to-finds are kept (secondary metric,
  tolerant of clustering).
- **`noise`** — a finding we do **not** want to reward: a false positive, a
  self-neutralizing observation ("...but actually it's safe"), or a **duplicate of a
  must-find** that would inflate recall if scored twice. The `justification` says which.

Genuinely ambiguous calls carry an **`AMBIGUOUS —`** prefix in the `justification` and
are surfaced to the maintainer rather than guessed (see `copirate-eval-harness-2fk.1`
epic notes).

## The current golden set

| case                              | repo (lang)               | PR   | change kind          | findings (must/nice/noise) |
|-----------------------------------|---------------------------|------|----------------------|----------------------------|
| `cc-candybar-150-transcript-perf` | cc-candybar (TS)          | #150 | perf refactor        | 17 (7 / 8 / 2)             |
| `links-317-dolt-telemetry`        | links-issue-tracker (Go)  | #317 | supply-chain removal | 7 (3 / 3 / 1)              |
| `copirate-93-dependency-diff`     | copirate-code-review (JS) | #93  | feature              | 7 (3 / 4 / 0)              |
| `laws-4-eval-tasks`               | laws (Markdown/shell)     | #4   | eval task specs      | 6 (2 / 3 / 1)              |

**37 findings total — 15 must-find.** Diverse across language (TS/Go/JS/Markdown) and
change kind (perf, supply-chain, feature, spec/CI).

## Adding a new case

1. **Freeze the mechanical inputs** with the freezer, which resolves the reviewed head
   SHA, saves the three-dot diff, captures the head tree as a tarball, extracts the
   review's inline findings into a draft `expected.json` (annotations set to
   `UNREVIEWED`), and writes `case.json` — validating every step and aborting loudly on
   any miss (`[LAW:no-silent-failure]`):

   ```bash
   eval/freeze-case.sh <case-name> <owner/repo> <pr> <review-id> [exclude-patterns]
   # e.g.
   eval/freeze-case.sh cc-candybar-150-transcript-perf promptctl/cc-candybar 150 4669719961
   ```

   Find the marker-bearing review id with:
   ```bash
   gh api --paginate repos/<owner>/<repo>/pulls/<pr>/reviews \
     --jq '.[] | select(.body|test("copirate-code-review-agent")) | {id, commit_id, state}'
   ```
   Pass `[exclude-patterns]` only if the source repo's `code-review.yml` overrides
   `EXCLUDE_PATTERNS`; otherwise the freezer uses `action.yml`'s default.

2. **Annotate `expected.json` by hand.** Replace every `UNREVIEWED` with `must-find` /
   `nice-to-find` / `noise` and a written `justification`, reading each finding against
   the actual code — do not trust the agent's own blocking/advisory label. Prefix
   genuinely ambiguous calls with `AMBIGUOUS —` and raise them with the maintainer. A
   left-over `UNREVIEWED` is intentionally loud so an un-annotated case is never
   silently scored.

3. **Commit** the whole case dir (`case.json`, `change.diff`, `repo.tar.gz`,
   `expected.json`). No version bump — `eval/` is dev-only tooling.
