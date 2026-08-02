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

Every finding's `diffHunk` body is a **verbatim substring of `change.diff`** — the
freezer asserts this for each finding and aborts if any hunk is missing, so the anchors
and the frozen diff cannot be committed inconsistent.

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

## Replaying a case

`eval/run-case.js` (`npm run review:case`) re-runs a frozen case through the **real**
review engine — the same prompts, the same adaptive scout→workers `runMultiScope` pass,
and the same MCP collector production uses — with **no GitHub**. It reuses the action's
own seams (`synthesizeProviderConfig`, `parseUnifiedDiff`, `buildPrMaterial`,
`runMultiScope`), exactly as `scripts/local-review.js` does, so it is an **instrument,
not a second review implementation**: a measured difference between two engine versions
is attributable to the code change under test, never to a replay that drifted.

```bash
DEEPSEEK_API_KEY=… node eval/run-case.js eval/cases/<case-name> -n 3
# options: -n/--repeats <N> (default 1), --out <dir> (default eval/out), --workers <N> (default 4)
```

It extracts `repo.tar.gz` to a temp dir (that becomes `REVIEWED_REPO_ROOT`), feeds
`change.diff` through the real diff seam, and drives the engine on the case's **pinned**
provider/model. The credential is read from the same env var the action uses
(`DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `OPENAI_API_KEY`, selected by `case.json`'s
provider). The engine cannot be overridden on the command line — a replay on a different
model than the pin is **refused loudly**, since it would corrupt any baseline comparison.
It also refuses loudly on a missing credential or a missing/corrupt `repo.tar.gz`.

Each replay is **append-only**: one invocation stamps a timestamp and writes one
directory per repeat, so a re-run never clobbers a prior batch's artifacts.

```
eval/out/<case-name>/<timestamp>-run<i>/
  findings.json   — the raw merged findings from runMultiScope, PRE anchor-partition:
                    an array of { path, line, body, severity }. This is what the scorer
                    (copirate-eval-harness-2fk.3) matches against expected.json.
  summary.txt     — the aggregated multi-scope review summary.
  usage.json      — { inputTokens, outputTokens, cost } (cost is the existing discriminated
                    value: { available:true, usd } or { available:false, reason }).
  meta.json       — provenance: case, timestamp, run index, the resolved engine config, findingCount.
  transcripts/    — the full per-spawn session transcripts (scout + one per scope).
```

`eval/out/` is git-ignored — run artifacts are never committed. Like everything under
`eval/`, `run-case.js` is dev-only tooling and does **not** bump the version.

## Scoring a replay

`eval/score.js` (`npm run review:score`) reduces a case's replay artifacts to the
number the harness exists to protect: **must-find recall** (found / total must-find),
plus nice-to-find recall, noise count, and cost — the secondary metrics. It is an
**instrument, not a second review implementation**: it never re-runs the engine and
never re-derives the expected set; it only *matches* the frozen `expected.json` against
a run's `findings.json` and reduces the match to metrics.

```bash
DEEPSEEK_API_KEY=… node eval/score.js eval/out/<case-name> [options]
# options: --matcher llm|lexical (default llm), --cases-dir <dir> (default eval/cases),
#          --cache <file> (default eval/out/.judge-cache.json)
```

The match is **two stages, cheap first**:

1. **Candidate pairing** (pure, deterministic) — a produced finding can match an
   expected one only when the **path is identical** and the new-file line is within a
   ±10 window (findings legitimately anchor a few lines off; `partitionFindings`'
   `MAX_ANCHOR_SNAP_DISTANCE` is the precedent).
2. **Semantic identity** — does the produced body describe the **same defect** as the
   expected body? This is the one judgment that isn't lexical, so it is the one
   **effect**: an LLM judge (a cheap pinned model, `deepseek-v4-flash`, over the same
   `DEEPSEEK_API_KEY`) rules match / no-match on each candidate pair. The scoring core
   never knows which judge it holds — the offline `--matcher lexical` (deterministic
   word-overlap) is the same `judge(pairs) → decisions` shape and needs no credential.

**Determinism** (scoring the same `findings.json` twice yields the identical scorecard)
is a *structural* property of a **content-keyed cache**, not a hope about LLM
temperature: the first scoring populates `eval/out/.judge-cache.json`; every later
scoring reads it, so the judge is never re-consulted for a pair it already ruled on.
The cache key includes a `JUDGE_VERSION` token, so changing the judge prompt or model
can never silently reuse a stale ruling.

```
eval/out/<case-name>/
  <ts>-run<i>/scorecard.json   — per run: must-find/nice-to-find recall (found, total, foundIds,
                                 missedIds), noise items, cost, and the per-pair match detail.
  scorecard-summary.json       — across the case's runs: mean/min/max recall band, the shape 2fk.4
                                 (baseline/variance) reduces.
```

The judge is a **measurement instrument** and is validated once: hand-match the
flagship case, run the judge, and require ≥90% agreement before trusting it (recorded on
`copirate-eval-harness-2fk.3`). If agreement ever fails, `--matcher lexical` is the
declared fallback. Like the rest of `eval/`, `score.js` is dev-only and does **not** bump
the version.

## Freezing a baseline

`eval/baseline.js` (`npm run review:baseline`) reduces the whole scored suite into one
**frozen baseline** — the reference distribution the compare gate
(`copirate-eval-harness-2fk.5`) measures a candidate engine change against. It is an
instrument, not a third scorer: it never re-runs the engine and never re-scores. It only
*collects* the per-case `scorecard-summary.json` bands `score.js` already wrote, tags them
with the exact `main` SHA + pinned engine that produced them, derives the suite's pooled gate
floor + each case's diagnostic floor and the suite cost, and writes the result under
`eval/baseline/<date>-<short-sha>/`.

Full-suite workflow (run → score → freeze):

```bash
# 1. Replay every golden case N times (N=5 for the current baseline; rationale below).
for c in eval/cases/*/; do DEEPSEEK_API_KEY=… node eval/run-case.js "$c" -n 5; done
# 2. Score each case (writes scorecard-summary.json per case).
for c in eval/out/*/; do DEEPSEEK_API_KEY=… node eval/score.js "$c"; done
# 3. Freeze the scored suite into a committed baseline (baseline.json + baseline.md).
node eval/baseline.js
```

`baseline.js` refuses to freeze an inconsistent suite loudly: every case must have been
scored over the same N, with the same matcher, on the same pinned engine, and every frozen
golden case must have a scored summary — a golden case with no summary aborts, so a partial
baseline never masquerades as complete. (The golden set is `cases-dir`, so a scored dir under
`eval/out/` with no matching golden case — an experimental or stale run — is simply not part
of the suite and is ignored, not an error.) Unlike the run/score artifacts
under `eval/out/` (git-ignored), the baseline directory is **committed**: it is the
ground-truth reference, versioned alongside the code it characterizes. `baseline.js` is
still dev-only tooling and does **not** bump the version.

```
eval/baseline/<date>-<short-sha>/
  baseline.json   — the frozen distribution: the suite's pooled must-find gate floor (the one gate number),
                    each case's must-find recall band (mean/min/max) + diagnostic floor, the suite cost, the
                    pinned engine, and the degradation rule. parseBaseline (exported) is the loader the
                    compare gate (2fk.5) reuses.
  baseline.md     — the same, human-readable: the per-case band table, suite cost, and the rule.
```

### The degradation rule

A candidate (an engine/prompt/effort change under test) is scored by replaying the **same**
suite at the **same** N, **pooling** every run's must-find finds into one rate, and comparing
it to the frozen baseline:

> **The suite is DEGRADED when the candidate's *pooled* must-find recall — total must-finds
> found across all N×cases runs ÷ total must-find opportunities — falls below this baseline's
> pooled gate floor (the pooled rate minus a ~2σ binomial sampling margin).**

The gate is **pooled, not per-case**, and that choice is forced by the data. Must-find
denominators are tiny (7, 3, 2, 3 across the four cases), so per-case recall is **quantized
and jittery**: for a 3-finding case it can only be 0, ⅓, ⅔, or 1, a single finding flipping
swings it 33 points, and — as the baseline below shows — the run-to-run spread exceeds the
mean for three of the four cases, with three per-case floors sitting at 0 % (a "mean below the
floor" rule can never fire there). A per-case gate is false precision. Pooling all the
must-find opportunities into one binomial rate restores a sample large enough to carry a real
sampling margin, so the floor is a meaningful line rather than noise. The per-case bands are
kept only as **diagnostics** — they localize *which* case moved a pooled regression; they do
not gate on their own.

### The first baseline, and the variance that shaped the rule

The first frozen baseline is
[`eval/baseline/2026-08-01-dc87ee0/`](baseline/2026-08-01-dc87ee0/baseline.md) — `main` at
`dc87ee0`, engine `deepseek-v4-pro`, N=5. Headline: **pooled must-find recall 19 % (14 of
75 opportunities), gate floor 10 %.** A full suite run (all four cases once) costs ≈ $0.70;
the whole N=5 baseline cost **$3.48**.

The per-case variance behind the pooled rule (above) is stark — every case's run-to-run
spread is large relative to its mean, and for three of the four the spread *exceeds* the mean:

| case | must-find | mean | min–max | per-run finds |
|------|-----------|------|---------|---------------|
| `cc-candybar-150-transcript-perf` | /7 | 14 % | 0–43 % | 1·3·0·0·1 |
| `copirate-93-dependency-diff`     | /3 | 13 % | 0–33 % | 0·1·1·0·0 |
| `laws-4-eval-tasks`               | /2 | 10 % | 0–50 % | 0·0·1·0·0 |
| `links-317-dolt-telemetry`        | /3 | 40 % | 33–67 % | 1·1·1·2·1 |

The three 0 % floors are why a per-case gate would police only `links-317`; the pooled rate
folds all 75 opportunities into one number instead.

### Is N stable enough to gate on?

**For the pooled rate, yes at N=5; for per-case recall, no at any practical N.** The pooled
rate aggregates 75 Bernoulli trials, so its ~2σ sampling margin is about ±9 points (a 10 %
floor under a 19 % mean) — tight enough that a candidate dipping below the floor is real
degradation, not jitter. Per-case recall is the opposite: with denominators of 2–7 findings
a single finding flipping swings recall 33–50 points, the run-to-run spread exceeds the mean
for three of four cases, and shrinking a per-case mean's standard error enough to gate would
take ~30+ repeats per case (~$20 and hours) — not worth it. So the harness gates on the
pooled suite rate, uses the per-case bands only to localize a regression, and **N=5 is the
standing baseline depth.**

The deeper result is the epic's headline, and it is not a defect in the harness: current
must-find recall is **~19 %** — the engine reproduces roughly one in five of the golden
set's hardest findings. The instrument is faithful (the LLM judge agreed with hand-matching
11/11 during `copirate-eval-harness-2fk.3`); the low number is the truth it was built to
measure. It is the floor the efficiency epic (`copirate-efficiency-235`) must not push
lower, and the bar the quality work must raise.

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
