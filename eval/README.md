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

One case = **one frozen review round plus its PR's pooled finding inventory**. The
*replay material* is a single reviewed commit: the exact diff the agent saw at that
commit and the repo tree at that commit, frozen so the case replays identically forever.
The *ground truth* is wider than that one round: the `expected.json` findings array
pools **every distinct finding from all of the source PR's review rounds that exists in
the frozen material** — because in practice a PR's full finding set dribbled out across
up to five push-triggered rounds (typically 1–2 findings per round on largely unchanged
code), and the recall epic (`zai-recall-upr`) asks whether **one** round can surface
what five rounds found together. That question is unmeasurable if each case's ground
truth is only its own round's findings.

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

The engine is pinned explicitly (currently `claude-subscription` / `claude-sonnet-5`,
what `PROVIDER=auto` resolves to and therefore the engine production runs) so a later
change to the default cannot silently move the baseline. `[LAW:no-silent-failure]`
`freeze-case.sh` derives the pin it writes from `src/provider.js` rather than carrying a
copy — a hardcoded pair is what left every case pinned to `deepseek` after 1.42.0
retargeted `auto`, which is how the harness came to be unable to replay on the provider
it was measuring.

`producedBy` is a *different* fact from `engine`, and they are not kept in step: it
records the config that produced the historical golden review this case was curated
from, which for every case here is `auto→deepseek / claude-code / deepseek-v4-pro`. The
`engine` pin is what a replay runs on **today**. They coincided once; conflating them
again would falsify the provenance.

### `expected.json`

```
{ "reviewId": <n>, "headSha": "<sha>", "findings": [ <finding>, ... ] }
```

Each finding:

| field          | meaning                                                                   |
|----------------|---------------------------------------------------------------------------|
| `commentId`    | the GitHub review-comment id (provenance back to the source PR)           |
| `reviewId`     | *(inventory findings only)* the source round that reported it; absent = the frozen round (the top-level `reviewId`) |
| `path`         | file the finding anchors to                                               |
| `line`         | new-file line **in the frozen material** (re-anchored by hand for inventory findings) |
| `side`         | diff side, always `RIGHT`                                                  |
| `annotation`   | `must-find` \| `nice-to-find` \| `noise` (see below)                       |
| `justification`| written rationale for the annotation (for inventory findings: also the eligibility evidence and the original anchor) |
| `diffHunk`     | *(frozen-round findings only)* the exact hunk GitHub anchored the comment to |
| `body`         | the verbatim finding text the agent posted                                |

Every frozen-round finding's `diffHunk` body is a **verbatim substring of
`change.diff`** — the freezer asserts this for each finding and aborts if any hunk is
missing, so the anchors and the frozen diff cannot be committed inconsistent. Inventory
findings carry no `diffHunk`: their GitHub hunk belongs to a *different* commit, so
committing it here would misdescribe the frozen material; their anchor is instead
verified at curation time (see below).

### The pooled inventory, and its eligibility rule

A finding from a non-frozen round may be added to `expected.json` only when **the
defect it describes exists in the frozen material**, and its `path`/`line` must be
**re-anchored to the frozen head's coordinates** on an anchorable line of
`change.diff`. That rule is what keeps the map true (`[FRAMING:representation]`):

- A finding **fixed before the frozen head** is not a recall opportunity there —
  including it would inflate the denominator with permanently-unrecallable entries.
- A finding about **code a post-frozen fix introduced** (a missed spot *of a fix*, a
  refinement of a fix's new code) does not exist in the frozen material — same
  exclusion.
- A finding that **duplicates** a frozen or inventory entry (later rounds re-tell
  earlier stories) is deduplicated into the one entry; the justification names the
  duplicate.
- A finding the PR author **refuted with proof** (pushback accepted, no change) enters
  as `noise` — a known plausible false positive, so an engine that repeats it is not
  charged with *novel* noise, and it never counts toward recall.

Each inventory entry's `justification` records the verdict evidence (confirmed + fix
commit, or refuted), the original anchor (`:line@commit`), and — where relevant — the
frozen-tree verification. Curation is a hand-judgment step, exactly like annotation:
mine the non-frozen marker rounds with `gh api`, read each finding against the frozen
tree (`repo.tar.gz`) and the author's reply threads, and verify every new anchor lands
on an anchorable `change.diff` line (`patchLines` in `src/diff.js` is the authority).

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

Every source PR took **five** review rounds; each case freezes its richest round as the
replay material and pools the other rounds' eligible findings as inventory.

| case                              | repo (lang)               | PR   | change kind          | inventory (must/nice/noise) | of which frozen round |
|-----------------------------------|---------------------------|------|----------------------|-----------------------------|-----------------------|
| `cc-candybar-150-transcript-perf` | cc-candybar (TS)          | #150 | perf refactor        | 32 (10 / 15 / 7)            | 17 (7 / 8 / 2)        |
| `links-317-dolt-telemetry`        | links-issue-tracker (Go)  | #317 | supply-chain removal | 14 (4 / 9 / 1)              | 7 (3 / 3 / 1)         |
| `copirate-93-dependency-diff`     | copirate-code-review (JS) | #93  | feature              | 9 (4 / 5 / 0)               | 7 (3 / 4 / 0)         |
| `laws-4-eval-tasks`               | laws (Markdown/shell)     | #4   | eval task specs      | 15 (2 / 12 / 1)             | 6 (2 / 3 / 1)         |

**70 findings total — 20 inventory must-finds (15 of them in the frozen rounds).**
Diverse across language (TS/Go/JS/Markdown) and change kind (perf, supply-chain,
feature, spec/CI). `laws-4`'s dribble was entirely low-stakes maintainability notes, so its inventory
adds nice-to-finds but no must-finds — an honest reflection of that PR, not a curation gap.

## Replaying a case

`eval/run-case.js` (`npm run review:case`) re-runs a frozen case through the **real**
review engine — the same prompts, the same adaptive scout→workers `runMultiScope` pass,
and the same MCP collector production uses — with **no GitHub**. It reuses the action's
own seams (`synthesizeProviderConfig`, `parseUnifiedDiff`, `buildPrMaterial`,
`runMultiScope`), exactly as `scripts/local-review.js` does, so it is an **instrument,
not a second review implementation**: a measured difference between two engine versions
is attributable to the code change under test, never to a replay that drifted.

```bash
CLAUDE_CODE_OAUTH_TOKEN=… node eval/run-case.js eval/cases/<case-name> -n 3
# options: -n/--repeats <N> (default 1), --out <dir> (default eval/out), --workers <N> (default 4)
```

It extracts `repo.tar.gz` to a temp dir (that becomes `REVIEWED_REPO_ROOT`), feeds
`change.diff` through the real diff seam, and drives the engine on the case's **pinned**
provider/model. The credential is read from the same env var the action uses
(`CLAUDE_CODE_OAUTH_TOKEN` / `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `OPENAI_API_KEY`,
selected by `case.json`'s provider) — and that mapping is `src/provider.js`'s own, read
through `resolveProviderConfig`, not a list this harness keeps. The engine cannot be
overridden on the command line — a replay on a different
model than the pin is **refused loudly**, since it would corrupt any baseline comparison.
It also refuses loudly on a missing credential or a missing/corrupt `repo.tar.gz`.

Each replay is **append-only**: one invocation stamps a timestamp and writes one
directory per repeat, so a re-run never clobbers a prior batch's artifacts.

```
eval/out/<case-name>/<timestamp>-run<i>/
  findings.json   — the raw merged findings from runMultiScope, PRE anchor-partition:
                    an array of { path, line, body, severity } — severity is an integer
                    1-5 priority label from 1.41.0 on (older frozen runs carry the legacy
                    'blocking'/'advisory' strings; the scorer reads both). This is what the scorer
                    (copirate-eval-harness-2fk.3) matches against expected.json.
  summary.txt     — the aggregated multi-scope review summary.
  usage.json      — { tokens, span, cost }. tokens is the disjoint token record
                    { inputCacheMiss, inputCacheHit, output }; span is { from, to } ISO
                    timestamps bounding the pass; cost is the basis-discriminated value
                    ({ basis:'dollars', usd } | { basis:'subscription', notionalUsd: number|null } |
                    { basis:'unpriced', reason }). A run captured before the token split
                    carries a collapsed inputTokens/outputTokens pair instead, and reads
                    back as tokens: null — absent, never zero.
  meta.json       — provenance: case, timestamp, run index, the resolved engine config, findingCount.
  transcripts/    — the full per-spawn session transcripts (scout + one per scope).
```

`eval/out/` is git-ignored — run artifacts are never committed. Like everything under
`eval/`, `run-case.js` is dev-only tooling and does **not** bump the version.

## Scoring a replay

`eval/score.js` (`npm run review:score`) reduces a case's replay artifacts to the
number the harness exists to protect: **inventory must-find recall** (found / total
must-find across the whole pooled inventory — the gate metric), reported alongside the
frozen-round must-find recall (the pre-inventory view, comparable with older runs),
plus nice-to-find recall, noise count, and cost — the secondary metrics. Matching runs
round-agnostically over the whole inventory; the frozen-round and inventory views are
derived per-bucket filters of one matched set, so a produced finding that matches a
*later-round* defect counts as an early find, never as noise. It is an
**instrument, not a second review implementation**: it never re-runs the engine and
never re-derives the expected set; it only *matches* the frozen `expected.json` against
a run's `findings.json` and reduces the match to metrics.

```bash
ANTHROPIC_API_KEY=… node eval/score.js eval/out/<case-name> [options]
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
   **effect**: an LLM judge (a cheap pinned model snapshot, `claude-haiku-4-5-20251001`,
   over its own `ANTHROPIC_API_KEY`) rules match / no-match on each candidate pair. The
   judge's credential is deliberately **not** the engine's: it is the ruler, and a ruler
   that moved with the thing it measures would measure nothing. The scoring core
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
CLAUDE_CODE_OAUTH_TOKEN=… node eval/freeze-suite.js -n 5 --out eval/out/freeze-<sha>
# 2. Score each case (writes scorecard-summary.json per case).
for c in eval/out/freeze-<sha>/*/; do ANTHROPIC_API_KEY=… node eval/score.js "$c"; done
# 3. Freeze the scored suite into a committed baseline (baseline.json + baseline.md).
node eval/baseline.js --out-dir eval/out/freeze-<sha>
```

Step 1 is `eval/freeze-suite.js` and not a shell loop over `run-case.js` because a suite is
~20 replays over several hours against a subscription that walls for hours at a time, and the
loop had no way to survive that. The suite runner adds exactly three things and reimplements
nothing — every job is still `run-case.js -n 1` in its own process:

- **A census, so it resumes.** A completed run is a dir carrying `findings.json` (the
  scorer's own definition, exported from `score.js` so the two cannot disagree). The runner
  counts what is already there and plans only the deficit, so re-running the command after a
  wall picks up where it stopped — there is no resume flag because there is no resume mode.
- **Level-filling order.** A job exists for case *c* at level *r* iff *c* has fewer than *r*
  completed runs, so every case is deepened before any one of them is. An interruption leaves
  an even suite (a valid smaller N — `baseline.js` demands one common N) instead of 5/5/5/0,
  which freezes nothing. The closing report names the deepest freezable N.
- **A deadline per replay** (`--job-timeout`, default 120 minutes). A throttled credential does not
  reliably *fail* — the engine CLI can sit in silent retry — and one lane waiting on it holds the
  queue forever. On expiry the replay's whole process group is killed (the engine's workers are
  grandchildren; signalling only the direct child would orphan them still burning quota) and the job
  is reported as `TIMED OUT`, never as an ordinary non-zero exit.
- **One lane per credential.** `--credentials VAR1,VAR2,…` names environment variables
  holding one credential each and replays on all of them concurrently; each lane is
  sequential, and a lane stops at its first failure (a walled credential fails everything it
  is handed) after returning the job to the queue for a lane that still works. Which env var
  the credential travels under is derived from `src/provider.js`, not written here.

The runner exits non-zero whenever any case is still short of the target, and prints every
attempt with its exit code, wall clock, and log path — the crashed 2026-08-30 freeze left two
empty run dirs that nobody noticed for five days, which is the failure this makes impossible.

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
  baseline.json   — the frozen distribution (schema v2): the suite's pooled INVENTORY must-find gate floor
                    (the one gate number), the frozen-round pooled rate (continuity diagnostic), each case's
                    inventory + frozen-round recall bands (mean/min/max) + diagnostic floor, the suite cost,
                    the pinned engine, and the degradation rule. parseBaseline (exported) is the loader the
                    compare gate (2fk.5) reuses, and evaluateGate is the one predicate that applies the rule.
  baseline.md     — the same, human-readable: the per-case band table, suite cost, and the rule.
```

### The degradation rule

A candidate (an engine/prompt/effort change under test) is scored by replaying the **same**
suite at the **same** N, **pooling** every run's inventory must-find finds into one rate, and
comparing it to the frozen baseline:

> **The suite is DEGRADED when the candidate's *pooled inventory* must-find recall — total
> inventory must-finds found across all N×cases runs ÷ total inventory must-find
> opportunities, where a case's inventory pools every distinct must-find from all of its
> source PR's review rounds that exists in the frozen material — falls below this baseline's
> pooled gate floor (the pooled rate minus a ~2σ binomial sampling margin).**

`evaluateGate` in `eval/baseline.js` is the single enforcer of this rule
(`[LAW:single-enforcer]`): the compare CLI (2fk.5) wraps it, and its behavior — the gate
fails a candidate whose pooled inventory recall drops below the frozen floor — is pinned by
`test/eval-baseline.test.js`. For a case with no inventory rounds the inventory equals the
frozen round, so this gate is a strict generalization of the earlier frozen-round gate; the
frozen-round pooled rate stays in the baseline as a continuity diagnostic comparable with
the pre-inventory (v1) baseline.

The gate is **pooled across runs, not per-case**, and that choice is forced by the data.
Must-find denominators are small, so per-case recall is **quantized and jittery**: for a
3-finding case it can only be 0, ⅓, ⅔, or 1, a single finding flipping swings it 33 points,
and — as the first baseline showed — the run-to-run spread exceeds the mean for three of the
four cases, with three per-case floors sitting at 0 % (a "mean below the floor" rule can
never fire there). A per-case gate is false precision. Pooling all the must-find
opportunities into one binomial rate restores a sample large enough to carry a real sampling
margin, so the floor is a meaningful line rather than noise. The per-case bands are kept only
as **diagnostics** — they localize *which* case moved a pooled regression; they do not gate
on their own.

### The current baseline (v2, inventory-gated)

The gate reference is
[`eval/baseline/2026-08-10-787df41/`](baseline/2026-08-10-787df41/baseline.md) — the engine
of `main` at `787df41`, `deepseek-v4-pro`, N=5, schema v2. Headline: **pooled inventory
must-find recall 22 % (22 of 100 opportunities), gate floor 14 %.** The frozen-round pooled
rate measured 21 % (16/75) — statistically consistent with the v1 baseline's 19 % on the same
engine, so the instrument is stable; the inventory gate simply measures against the fuller
ground truth (100 opportunities vs 75). A full suite run still costs ≈ $0.68; the whole N=5
baseline cost $3.41. The headline result carries over: the engine surfaces roughly **one in
five** of the pooled inventory's must-finds in a single round — that is the number the recall
epic (`zai-recall-upr`) exists to raise, and the floor the efficiency work must not sink.

### The first baseline, and the variance that shaped the rule

The first frozen baseline is
[`eval/baseline/2026-08-01-dc87ee0/`](baseline/2026-08-01-dc87ee0/baseline.md) — `main` at
`dc87ee0`, engine `deepseek-v4-pro`, N=5, **schema v1** (pre-inventory: its ground truth was
each case's frozen round only, and its gate metric the frozen-round pooled rate — kept as
history; the current v2 baseline supersedes it as the gate reference). Headline: **pooled
must-find recall 19 % (14 of 75 opportunities), gate floor 10 %.** A full suite run (all four
cases once) costs ≈ $0.70; the whole N=5 baseline cost **$3.48**.

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

## Comparing a candidate — the quality gate

`eval/compare.js` (`npm run review:compare`) is the command the whole epic exists for: **"did my
change degrade finding quality?"** answered as a measured verdict, not a guess. It gates the
**current working tree** (the candidate — the replay runner drives `src/` directly, so the candidate
is simply the code as checked out; no build or publish) against a frozen baseline.

```bash
ANTHROPIC_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… node eval/compare.js
# options: --baseline <dir|baseline.json> (default: newest under eval/baseline/ by COMMIT-GRAPH order,
#            not directory-name order — an uncommitted baseline.json always outranks a committed one;
#            refused if the newest can't be determined unambiguously, e.g. a shallow git clone with
#            more than one candidate),
#          --matcher llm|lexical (default llm; MUST match the baseline's matcher; IGNORED under
#            --reuse-candidate, where the reused summaries' own recorded matcher is checked instead),
#          --out <dir> (default eval/out/candidate-<ts>, git-ignored; mutually exclusive with
#            --reuse-candidate; refused if it already holds run artifacts for a case),
#          --workers <N> (default 4), --cases-dir <dir>, --cache <file>,
#          --reuse-candidate <dir> (gate an already-produced candidate root; no replay, no spend;
#            mutually exclusive with --out)
```

ANTHROPIC_API_KEY is required **unconditionally** for the default `--matcher llm` (the judge's own
credential), regardless of which provider the baseline's pinned engine itself uses — pass
`--matcher lexical` to avoid it. It is a *second* credential alongside the engine's
(`CLAUDE_CODE_OAUTH_TOKEN` for the current pins), on purpose: a subscription OAuth token authenticates
the review CLI, not the raw Messages call the judge makes, and a judge sharing the engine's credential
would be a ruler that moves with what it measures.

**A candidate is just another suite.** `compare.js` reimplements no pooling, no scoring, and no
gate predicate — it:

1. replays every baseline case **N times** (N and the engine come *from the baseline*, and are
   asserted — a candidate run at a different N or engine measures something else) by spawning
   `run-case.js`, then scores each with `score.js`, into an isolated candidate root;
2. reduces the candidate's scored summaries into a suite with the **same `buildBaseline`** the
   frozen baseline was built with — so the producer and the comparator can never drift
   (`[LAW:one-source-of-truth]`); and
3. applies the frozen [degradation rule](#the-degradation-rule) via `baseline.js`'s `evaluateGate`
   (`[LAW:single-enforcer]`): **candidate pooled inventory must-find recall < the baseline's pooled
   gate floor ⇒ DEGRADED.**

It prints the **estimated cost up front** (the baseline's recorded `$/full-run` × N), then a
per-case verdict table and a final `DEGRADED` / `OK` / `IMPROVED` line — Markdown, so it pastes
straight into a PR body. The per-case bands are diagnostics that localize *which* case moved a
pooled regression (a `moved?` ⚠️ marks a case whose candidate mean fell below its baseline
diagnostic floor); they never gate on their own. Artifacts land at `<out>/verdict.{md,json}`.

**Exit codes are a trichotomy** so a CI gate (`copirate-eval-harness-2fk.6`) can tell the three
outcomes apart: `0` = ran and OK/IMPROVED, `1` = ran and **DEGRADED** (the gate tripped), `2` =
could not run (bad args, missing baseline, a matcher/N/engine that isn't comparable — refused
*before* any spend where possible).

### When to run it

Any PR that changes **prompts** (`src/prompt.js`, `review-agent/instructions.md`), **spawn
structure** (`src/multiscope.js`), or **effort/reasoning behavior** (`src/effort.js`) can silently
move finding quality. Run `eval/compare.js` and paste the verdict table into the PR body. The
efficiency epic's quality-sensitive tickets (`copirate-efficiency-235.2`–`.5`) name this as their
acceptance instrument.

### Running it in CI

`.github/workflows/eval.yml` runs the same command in GitHub Actions and puts the verdict where
reviewers look: the verdict table lands in the run's **Step Summary**, `DEGRADED` reds the check
(exit `1`), and the candidate root (per-run findings, scorecards, transcripts, `verdict.{md,json}`)
is uploaded as the `eval-candidate` artifact even on a red or aborted run.

Two triggers, both deliberate spends. `compare.js` prints the authoritative cost estimate (the
baseline's recorded $/full-run × N) before spending; as orientation, the current N=5 × 4-case
baseline puts a run at a few dollars and around an hour.

- **On demand**: `gh workflow run eval.yml` (optionally `--ref <branch>`) — pressing the button is
  the spend approval. The candidate is that ref's checkout.
- **Per PR, label-gated**: attach the **`eval`** label to a PR. There is *no* unconditional per-PR
  trigger, and unrelated label changes on an already-labeled PR do not re-run the suite; a push to
  a labeled PR does. The candidate is the PR merge ref — the code as it would land. Fork PRs never
  run the gate: GitHub withholds secrets from fork `pull_request` events, so the job skips them up
  front rather than failing mid-run on empty credentials.

The workflow checks out with `fetch-depth: 0` because the no-`--baseline` newest-pick ranks
committed baselines by commit-graph order, which a shallow clone collapses to a refused tie. It
forwards every credential a golden case's pinned provider can use (`CLAUDE_CODE_OAUTH_TOKEN`,
`DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `OPENAI_API_KEY` — the set `src/provider.js` declares); the cases'
pinned engine selects which one is read, so re-freezing the baseline onto another of these providers
changes no workflow line — but `ANTHROPIC_API_KEY` stays required regardless of the pins: the default
`llm` matcher's judge reads it unconditionally (`score.js`), and the current baseline's matcher is
`llm/claude-haiku-4-5-20251001`. Runs share one concurrency group — a second trigger
queues rather than interleaving spend.

### The gate's own validation (the sabotage test)

The gate is only trustworthy if it *fires* on a genuinely worse engine, so it is validated by
**deliberately degrading the worker prompt** and confirming `DEGRADED`: strip the "read the files
in full / follow the change to its call sites before judging" directive from `buildReviewInput`
(`src/prompt.js`) — the guidance most responsible for the subtle must-finds — and the pooled recall
collapses below the floor. That run is recorded on `copirate-eval-harness-2fk.5`. Self-consistency
(the baseline's own runs replayed through `compare.js --reuse-candidate` reproduce the baseline rate
⇒ `OK`) is the other half.

Like the rest of `eval/`, `compare.js` is dev-only tooling and does **not** bump the version.

## Adding a new case

1. **Freeze the mechanical inputs** with the freezer, which resolves the reviewed head
   SHA, saves the three-dot diff, captures the head tree as a tarball, extracts the
   review's inline findings into a draft `expected.json` (annotations set to
   `UNREVIEWED`), and writes `case.json` — validating every step and aborting loudly on
   any miss (`[LAW:no-silent-failure]`):

   ```bash
   eval/freeze-case.sh <case-name> <owner/repo> <pr> <review-id> [exclude-patterns] [produced-by]
   # e.g.
   eval/freeze-case.sh cc-candybar-150-transcript-perf promptctl/cc-candybar 150 4669719961
   ```

   The `engine` pin it writes is derived from `src/provider.js` (whatever `PROVIDER=auto`
   currently resolves to), so a retarget can never leave a new case pinned to a retired
   provider. `[produced-by]` defaults to that same engine — correct for a review run
   today; pass it explicitly when freezing an **older** review that a different engine
   produced, since `producedBy` records that history and not the replay pin.

   Find the marker-bearing review id with:
   ```bash
   gh api --paginate repos/<owner>/<repo>/pulls/<pr>/reviews \
     --jq '.[] | select(.body|test("copirate-code-review-agent")) | {id, commit_id, state}'
   ```
   Pass `[exclude-patterns]` only if the source repo's `code-review.yml` overrides
   `EXCLUDE_PATTERNS`; otherwise the freezer uses `action.yml`'s default.

2. **Annotate `expected.json` by hand.** Replace every `UNREVIEWED` with `must-find` /
   `nice-to-find` / `noise` and a written `justification`, reading each finding against
   the actual code — do not trust the agent's own severity label. Prefix
   genuinely ambiguous calls with `AMBIGUOUS —` and raise them with the maintainer. A
   left-over `UNREVIEWED` is intentionally loud so an un-annotated case is never
   silently scored.

3. **Curate the pooled inventory by hand** (the freezer only extracts the frozen
   round). Mine the PR's other marker-bearing rounds, apply the eligibility rule above
   (defect exists in the frozen material; re-anchor to frozen coordinates; dedupe;
   refuted findings become `noise`), and append each eligible finding with its source
   `reviewId`. A case may ship without inventory rounds — it then scores identically on
   both views — but the recall epic's metric only bites on cases that carry one.

4. **Commit** the whole case dir (`case.json`, `change.diff`, `repo.tar.gz`,
   `expected.json`). No version bump — `eval/` is dev-only tooling.
