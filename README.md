# CoPirate Code Review

A GitHub Action that runs an AI coding agent as a **read-only** code reviewer. It reviews a pull request diff and submits an inline GitHub review — `REQUEST_CHANGES` when it finds issues, otherwise an approval (a formal `APPROVE` when `GITHUB_REVIEW_TOKEN` is set; logged-only otherwise — see [Approvals](#approvals)) (or a "⏳ Partial review" `COMMENT` when part of the change went unreviewed — a partial review never approves). It can also do an on-demand whole-repo review (`MODE: repo`).

The review engine is chosen by `PROVIDER`, which defaults to `auto` (today: Claude Code against Anthropic, billed to your **Claude Pro/Max subscription** rather than per token). You can also run Claude Code against Z.ai, or Codex against OpenAI. The engine reviews read-only — it cannot push to GitHub itself; findings flow through a private collector and are submitted by the action.

## Quickstart

1. Mint a subscription token once, locally — `claude setup-token` prints one valid for a year — and add it as a `CLAUDE_CODE_OAUTH_TOKEN` repository secret (**Settings → Secrets and variables → Actions**), or via the CLI:

   ```bash
   claude setup-token                    # prints the token
   gh secret set CLAUDE_CODE_OAUTH_TOKEN # paste it at the prompt
   ```

   Prefer paying per token? Set that provider's key and name it explicitly with `PROVIDER:` — see [Providers](#providers).

2. Add `.github/workflows/code-review.yml`:

   ```yaml
   name: AI Code Review

   on:
     pull_request:
       types: [opened, synchronize, reopened]

   permissions:
     contents: read
     issues: write
     pull-requests: write

   # Cancel an in-flight review when a new commit is pushed, so a rapid
   # push loop doesn't pay for reviews of commits that are already replaced.
   concurrency:
     group: ai-code-review-${{ github.event.pull_request.number }}
     cancel-in-progress: true

   jobs:
     review:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v6
           with:
             ref: ${{ github.event.pull_request.head.sha }}

         - uses: promptctl/copirate-code-review-agent@v1
           with:
             CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
   ```

That's it. Open a PR and the action reviews it. The checkout is optional context for the reviewer — the review itself is fetched and posted through the GitHub API, so it works even without checking out the code.

## Providers

`PROVIDER` selects the engine in simple mode. Each provider needs its own credential secret.

| `PROVIDER` | Engine | Credential | Billing | Default model |
|---|---|---|---|---|
| `auto` *(default)* | Claude Code → Anthropic | `CLAUDE_CODE_OAUTH_TOKEN` | your Claude Pro/Max plan | `claude-sonnet-5` |
| `deepseek` | Claude Code → DeepSeek | `DEEPSEEK_API_KEY` | per token | `deepseek-v4-pro` |
| `zai` | Claude Code → Z.ai | `ZAI_API_KEY` | per token | `glm-5.1` |
| `codex` | Codex → OpenAI | `OPENAI_API_KEY` | per token | `gpt-5.4-mini` |
| `claude-subscription` | Claude Code → Anthropic | `CLAUDE_CODE_OAUTH_TOKEN` | your Claude Pro/Max plan | `claude-sonnet-5` |

`auto` resolves to whichever provider the action currently points at — **`claude-subscription` since 1.42.0**, DeepSeek before that. Pinning `auto` lets the maintainer retarget every consumer with a release, without anyone editing their workflow; supply the credential for whatever `auto` currently resolves to, or supply several and let the retarget be free. A repo missing the current target's credential **fails at startup naming the input to set** — loudly, before any spend — never by silently falling back to another provider whose key happens to be present.

To run Codex instead:

```yaml
      - uses: promptctl/copirate-code-review-agent@v1
        with:
          PROVIDER: codex
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

### Reviewing on a Claude Pro/Max subscription

`PROVIDER: claude-subscription` runs the same Claude Code engine against Anthropic's own API using your **subscription**, so a review consumes plan quota instead of billing per token. Its endpoint is **pinned to `https://api.anthropic.com`** — there is deliberately no `CLAUDE_BASE_URL`, and no input or config file can move it, because a subscription token is long-lived and broadly scoped and must never be sendable to a host chosen by configuration. Since 1.42.0 this is what the default `PROVIDER: auto` resolves to, so an unconfigured consumer gets it.

Mint the token once, locally — it is valid for a year:

```bash
claude setup-token          # prints the token; store it as a repo secret
```

```yaml
      - uses: promptctl/copirate-code-review-agent@v1
        with:
          PROVIDER: claude-subscription
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The same pin applies however you configure it — see [the two endpoint forms](#multi-engine-configuration). The preflight probe is skipped for an OAuth credential (and says so in the log) rather than guessing a request shape that could reject a working token.

For a failover chain or per-PR engine selection, use the [config file](#multi-engine-configuration) instead.

## Inputs

| Input | Default | Description |
|---|---|---|
| `PROVIDER` | `auto` | Engine: `auto`, `deepseek`, `zai`, `codex`, or `claude-subscription`. Ignored when a `CONFIG_FILE` exists. |
| `DEEPSEEK_API_KEY` | — | Required for `deepseek`. |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model for the `deepseek` provider. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic-compatible endpoint for `deepseek`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Required for `auto`/`claude-subscription`. A Claude Pro/Max token from `claude setup-token` (valid one year); the review is billed to the subscription's quota, not per token. Its endpoint is pinned to `https://api.anthropic.com` and there is no base-URL input for it. |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Model for the `claude-subscription` provider. |
| `ZAI_API_KEY` | — | Required for `zai`. |
| `ZAI_MODEL` | `glm-5.1` | Model for the `zai` provider. |
| `ZAI_BASE_URL` | `https://api.z.ai/api/anthropic` | Anthropic-compatible endpoint for `zai`. |
| `ZAI_SYSTEM_PROMPT` | — | Optional extra system prompt appended to the reviewer for the `zai` provider. Empty by default; the built-in review charter already carries the whole review standard. |
| `OPENAI_API_KEY` | — | Required for `codex`. |
| `OPENAI_MODEL` | `gpt-5.4-mini` | Model for the `codex` provider. |
| `OPENAI_REASONING_EFFORT` | — | `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-Responses-compatible endpoint (e.g. Azure or a gateway). |
| `MODE` | `pr` | `pr` (review a PR diff, post an inline review) or `repo` ([whole-repo review](#whole-repo-review)). |
| `SCOPE` | — | Free-text focus for `MODE: repo` (e.g. `the auth layer`). Ignored when `MODE: pr`. |
| `CONFIG_FILE` | `.github/review-agents.yml` | [Multi-engine config file](#multi-engine-configuration). When present it owns engine selection and the `PROVIDER`/key inputs are ignored. |
| `CONFIG` | — | Select a named config from the config file, overriding its `default`. |
| `ZAI_REVIEWER_NAME` | `CoPirate Code Review` | Name shown in the review comment header (applies to every provider; the `ZAI_` prefix is historical). |
| `EXCLUDE_PATTERNS` | `*.lock,package-lock.json,yarn.lock,pnpm-lock.yaml` | Comma-separated file patterns to exclude. |
| `MAX_DIFF_CHARS` | `0` (unlimited) | Max characters of diff sent to the engine. |
| `MAX_REVIEW_ROUNDS` | `5` | Max times the action reviews one PR; further pushes skip cleanly with no engine spawned (`0` = unlimited). Bounds cost on PRs pushed many times. |
| `TIME_BUDGET_MINUTES` | `25` | Wall-clock budget for the whole review run, in both modes. When it expires, the review stops starting new scope workers and sweeps and **delivers what it has** instead of the job's `timeout-minutes` cancelling the run with every finding undelivered: in `pr` mode the review is submitted with unreviewed scopes named in the summary and the verdict withholding approval; in `repo` mode the Step Summary report still renders, carrying the same partial-coverage note (there is no verdict to withhold). A budget that expires before **any** scope completes instead fails the run loudly, naming this input — there is no review to deliver. Set it a few minutes below the job's `timeout-minutes`. `0` = no budget. |
| `DAILY_BUDGET_USD` | `0` (off) | Daily spend ceiling honored as a **gradient** — see [Daily budget](#daily-budget). `0`/unset = off (today's default effort, no ledger I/O). PR mode only; requires `LEDGER_ISSUE` and `issues: write`. |
| `LEDGER_ISSUE` | — | Issue number of the append-only daily cost ledger the budget gradient reads and writes (typically `${{ vars.LEDGER_ISSUE }}`). Required when `DAILY_BUDGET_USD` is set. |
| `DIFFICULTY_SCALING` | `false` (off) | Scale review effort to change difficulty — see [Difficulty scaling](#difficulty-scaling). An easy diff draws fewer review rounds; a complex diff reasons harder each round. PR mode only. |
| `DEPENDENCY_DIFF` | `false` (off) | Fetch upstream commit/file context for a `go.mod` version bump — see [Dependency diff context](#dependency-diff-context). PR mode only. |
| `GITHUB_TOKEN` | `${{ github.token }}` | Token for GitHub API access (fetching the diff, posting the review). Defaults to the workflow's automatic token, which needs `pull-requests: write`. |
| `GITHUB_REVIEW_TOKEN` | — | Token used for all GitHub calls when set; required to submit a **formal approval** (see [Approvals](#approvals)). |
| `PR_NUMBER` | from event | PR number. Auto-detected on `pull_request` events; pass explicitly on others (e.g. `workflow_run`). |
| `HEAD_SHA` | from event | Head SHA the review anchors to. Auto-detected on `pull_request` events. |

The action installs its bundled reviewer instructions as the engine's user-global instructions for each run. The reviewed repository's own `CLAUDE.md`/`AGENTS.md` are **not** auto-loaded — each engine runs in an isolated working directory, so a committed instruction file cannot redirect the reviewer (it stays readable as plain context).

## Approvals

**Every finding blocks.** The reviewer makes no blocking/advisory call — a recorded finding is one the code must address, and any finding submits a `REQUEST_CHANGES` review. Each finding carries a **severity label, `1`–`5`** (rendered as `[S1]`–`[S5]` on the comment): pure priority information for the author — `5` ships a defect, `1` is reserved for trivia like a comment typo. Severity never changes the verdict; there is no non-blocking tier.

The default `GITHUB_TOKEN` cannot approve PRs. With no `GITHUB_REVIEW_TOKEN`:

- Any finding is submitted as a `REQUEST_CHANGES` review — anchored findings as inline threads, unanchored ones (an off-grid line or an unshowable file) in the review body's "Findings outside the reviewed diff" section.
- A clean review posts a `COMMENT` review whose body reads `✅ Approved`. The message lands on the PR either way; what the missing token costs you is only the *formal* `APPROVE` state, never the visible result.

Set `GITHUB_REVIEW_TOKEN` to an approval-capable user or GitHub App token to have clean reviews submit a formal `APPROVE`. When a finding exists the action requests changes — resolve the threads and dismiss the review to proceed.

**The partial exception:** a review that did not cover the whole change never approves, however clean — with or without `GITHUB_REVIEW_TOKEN` it posts a `COMMENT` review whose verdict reads `⏳ Partial review`, and the body names exactly what was missed. Approval asserts the whole diff was judged, and a partial review has no standing to assert it. Two things can leave a gap:

- The [time budget](#inputs) expired before every scope was reviewed — the unreviewed scopes are named in the summary.
- A changed file's path cannot be reviewed (it embeds a line separator, so no prompt line can name it and no review comment can anchor to it) — those files are listed under **Changed files NOT reviewed** with the reason.

## Fork PRs are never reviewed

PRs opened from a fork (head repo ≠ base repo) are skipped cleanly — logged, exit 0, no engine spawned, no review posted — *before any credential is read*. This is unconditional with no opt-in, so an outside contributor's PR can never spend the host's AI credits or meet a secret. Your own branches (head and base in the same repo) review normally.

## Daily budget

Set `DAILY_BUDGET_USD` to cap the action's spend across a day. It is honored **not as a hard cutoff** (full effort until the ceiling, then stop) but as a **gradient**: as the day's remaining budget shrinks, each review deliberately de-rates — today by reviewing a PR fewer times — so the budget lasts the day. A minimal review always runs; the budget lowers effort, it never cancels the review. Off by default (`0`/unset): the action runs at full effort with no ledger I/O.

How it works, per PR review (PR mode only):

1. **Read** the day's spend so far by summing an **append-only ledger** — a dedicated repo issue where every review appends its actual cost as one comment. The day's spend is a sum of immutable records (no shared mutable counter, race-free).
2. **Choose** the highest-effort profile whose estimated cost fits a per-review cap set to a *fraction of the remaining budget* — a curve that decays as the day depletes, so spend rations itself rather than running full-tilt into a wall.
3. **Review** at that effort, then **append** the review's actual cost to the ledger.

The estimate is a deterministic ranker calibrated on real runs (`src/budget.js`), not a billed figure. The budget only ever *lowers* effort below what `MAX_REVIEW_ROUNDS` configures — it never raises it.

To enable it:

```yaml
permissions:
  contents: read
  issues: write          # the ledger is a repo issue the action reads and appends to
  pull-requests: write

jobs:
  review:
    steps:
      - uses: promptctl/copirate-code-review-agent@v1
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DAILY_BUDGET_USD: "10"
          LEDGER_ISSUE: ${{ vars.LEDGER_ISSUE }}   # a repo Actions variable: the ledger issue number
```

Create one issue in the repo to serve as the ledger (its body is ignored; the action only appends comments) and set the repo Actions **variable** `LEDGER_ISSUE` to its number. If `DAILY_BUDGET_USD` is set without a valid `LEDGER_ISSUE`, the run fails loud — the gradient cannot ration spend without a ledger. A failed ledger read is spend-safe (the review proceeds at full effort with a warning); a failed append warns and continues (the ledger becomes a known lower bound). Both are loud, never silent.

## Difficulty scaling

Set `DIFFICULTY_SCALING: "true"` to match review effort to how hard the change actually is: a one-line typo fix and a concurrency refactor should not draw the same effort. The action derives a **free, pre-spend proxy** of the diff (its churn, how many files it spreads across, and whether it touches source vs. tests/docs only) and scales effort along **two axes**:

- **Cheaper for easy diffs** — a trivial change draws **fewer review rounds** (a substantial change still draws the full `MAX_REVIEW_ROUNDS`).
- **More thorough for complex diffs** — a substantial change **reasons harder each round** (raising the reasoning effort toward the engine's maximum), so a hard change gets deeper scrutiny per round without adding rounds.

Off by default: the action runs at full effort. PR mode only.

The round count is only ever **lowered** below `MAX_REVIEW_ROUNDS`; the reasoning tier is only ever **raised** above what a config configures — difficulty is a floor there, never a cap, and an explicitly-configured high reasoning tier is never lowered. It composes with the budget: **difficulty proposes, budget caps** — difficulty proposes a ceiling on both axes, then (if `DAILY_BUDGET_USD` is set) the budget gradient rations within it, capping the raised reasoning back down when spend is tight. The two activate independently — enable either or both.

```yaml
jobs:
  review:
    steps:
      - uses: promptctl/copirate-code-review-agent@v1
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DIFFICULTY_SCALING: "true"
```

## Dependency diff context

Set `DEPENDENCY_DIFF: "true"` to give the reviewer more than a version string when a PR bumps a `go.mod` requirement (for example, a Dependabot PR). When the diff changes a `go.mod` requirement line, the action resolves the bumped module to its GitHub repository and fetches the upstream commits and changed files between the old and new version via GitHub's compare API — then hands that as read-only context to the reviewer, which is instructed to check whether anything this repo actually calls into changed, broke, or was deprecated upstream, not just that a version moved.

This runs entirely in the **host action** — the reviewing engine is never granted `Bash`, `WebFetch`, or any other network-capable tool; only the trusted Node process fetches the upstream diff, exactly as it already fetches the PR's own diff.

Module resolution covers direct `github.com/...` module paths, the `golang.org/x/*` modules (mirrored 1:1 to `github.com/golang/*`), and falls back to the standard Go vanity-import discovery protocol for anything else. A module that can't be resolved to a GitHub repo (or whose compare call fails) is reported as such in the review context rather than silently omitted — the review still runs on the manifest diff alone. Every `go.mod` in the diff is scanned, not just the root one, so a monorepo's nested module bumps are covered too.

Three caps bound cost and prompt size, all reported to the reviewer rather than silently applied: at most 8 bumped modules per PR get their upstream context fetched (any beyond that are named in the note as skipped), and each fetched module's context is truncated to its most recent 30 commits and first 50 changed files — a bump spanning more than that still surfaces the truncation explicitly ("N total, most recent 30 shown") rather than pretending the shown range is everything.

Because the module path driving this feature comes from PR diff content, the discovery fallback resolves the target hostname via DNS first and refuses to fetch if any resolved address is loopback, private, or link-local (this also blocks the cloud metadata address, `169.254.169.254`) — a plain string-shape check alone cannot catch a hostname that resolves to an internal service. One known, accepted gap: this check has a DNS-rebinding TOCTOU window (the resolved address could change between the check and the real request), since pinning the connection to the checked address would require disabling TLS certificate verification against the hostname — strictly worse than the gap it would close.

Off by default: no `go.mod` scan, no outbound fetch. PR mode only.

```yaml
jobs:
  review:
    steps:
      - uses: promptctl/copirate-code-review-agent@v1
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          DEPENDENCY_DIFF: "true"
```

## Whole-repo review

Set `MODE: repo` for an on-demand review of the **whole working tree** instead of a PR diff. There's no PR: the engine explores the checked-out repo with Read/Grep/Glob, and findings are printed as a Markdown report to the **GitHub Step Summary** and run log — no inline comments, no review submitted, no write token needed. Unlike PR mode (which only flags what the diff introduces), repo mode deliberately flags **pre-existing** issues.

```yaml
name: AI Whole-Repo Review

on:
  workflow_dispatch:
    inputs:
      scope:
        description: "Optional focus, e.g. 'the auth layer'. Blank = broad review."
        required: false

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: promptctl/copirate-code-review-agent@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
        with:
          MODE: repo
          SCOPE: ${{ inputs.scope }}
```

Provider selection and `EXCLUDE_PATTERNS` work as in PR mode. The run is informational and exits 0 regardless of findings.

> **Scale limit:** it's a single agent run, so a broad pass over a very large repo can exceed the agent's context. Pass a `SCOPE` to focus on one subsystem at a time.

## Multi-engine configuration

Simple mode (the `PROVIDER` input) runs one engine. For a **failover chain**, **per-PR engine selection**, or **arbitrary engine/endpoint/model combinations**, commit `.github/review-agents.yml`. When it exists it owns engine selection, and the simple-mode `PROVIDER`/key inputs are ignored.

```yaml
version: 1                       # schema version; unknown version fails loudly
default: deepseek                # which config reviews when nothing else selects one
fallback:                        # optional ordered failover chain
  - deepseek
  - codex-gpt55

configs:
  deepseek:                      # MANUAL form — any apiType, any baseUrl, always an API key
    engine: claude-code          # claude-code | codex | opencode
    model: deepseek-v4-pro
    reasoning: high              # validated against the engine's declared efforts
    endpoint:
      apiType: anthropic-messages
      baseUrl: https://api.deepseek.com/anthropic
      credentialEnv: DEEPSEEK_API_KEY  # the NAME of an env var — never a secret value

  claude-sub:                    # PRESET form — the only way to reach a subscription token
    engine: claude-code
    model: claude-sonnet-5
    endpoint:
      preset: claude-subscription      # apiType + baseUrl + credential kind all pinned in code
      credentialEnv: CLAUDE_CODE_OAUTH_TOKEN

  codex-gpt55:
    engine: codex
    model: gpt-5.5
    reasoning: xhigh
    endpoint:
      apiType: openai-responses
      baseUrl: https://api.openai.com/v1
      credentialEnv: OPENAI_API_KEY
```

An `endpoint` is exactly one of two forms:

| form | fields | credential |
|---|---|---|
| **preset** | `preset`, `credentialEnv` | whatever the preset pins — **the only way to get `oauth`** |
| **manual** | `apiType`, `baseUrl`, `credentialEnv` | always `api-key` |

**That asymmetry is a security boundary, not an omission.** A subscription/OAuth token is long-lived and broadly scoped — its blast radius dwarfs a per-service API key — so it may only ever be sent to a host pinned in code. The manual form keeps every degree of freedom that is safe to have (any API shape, any URL, any env var) and simply cannot name a high-blast-radius credential. Reaching "OAuth token at a host of my choosing" therefore takes a code change to the preset table, reviewed like any other — not a YAML typo.

Every field is validated **once, at startup** against the engine's capabilities. An illegal combination (codex with an `anthropic-messages` endpoint, an `oauth` preset on an engine that cannot use one, a `baseUrl` written beside a `preset`, a `credentialKind` in the manual form, an unknown preset, a `reasoning` on opencode, an unknown engine, a `default`/`fallback` naming an undefined config, or a `credentialEnv` whose variable is unset) fails the run with a message naming the config, field, and allowed values.

> **Schema change in 1.43.0.** `endpoint.kind` is now `endpoint.apiType`, the `endpoint.auth.{method, …}` block is gone, and an endpoint is written as either the **preset** or **manual** form above. (`apiKeyEnv` became `credentialEnv` earlier, in 1.41.0 — unchanged here.) Existing config files need updating — the old shape fails at load with a message naming the field.

### Engine capability matrix

A config is rejected at load unless its `endpoint.apiType`, its credential kind, and its `reasoning` are valid for its `engine`:

| Engine | `endpoint.apiType` | credential kinds | `reasoning` efforts |
|---|---|---|---|
| `claude-code` | `anthropic-messages` | `api-key`, `oauth` | `low`, `medium`, `high`, `max` |
| `codex` | `openai-responses` | `api-key` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| `opencode` | `openai-chat`, `openai-responses`, `anthropic-messages` | `api-key` | *(none — setting `reasoning` is a config error)* |

`opencode` models are `<provider>/<model>`. The same provider can be reached through more than one engine — e.g. DeepSeek via `claude-code` (`anthropic-messages`, `…/anthropic`) or `opencode` (`openai-chat`, base host).

### Secrets

A config never holds a secret — `credentialEnv` names an env var the **workflow** maps from a GitHub secret. Map each one in the step's `env:` block:

```yaml
      - uses: promptctl/copirate-code-review-agent@v1
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        with:
          GITHUB_REVIEW_TOKEN: ${{ secrets.GITHUB_REVIEW_TOKEN }}
```

Every `credentialEnv` reachable in the chain must be set and non-empty at startup, or the run fails fast.

### Per-PR selection

Which config reviews a PR is resolved in precedence order (first match wins):

1. **Label** `review:<config-name>` on the PR (e.g. `review:codex-gpt55`). More than one is ambiguous and fails.
2. **PR-body trailer** `Review-Config: <config-name>` (case-insensitive, own line).
3. **`CONFIG` input** — a fixed choice in the workflow.
4. The file's **`default`**.

Selection only ever picks among configs the maintainer committed. A PR author can *steer* the review toward another configured engine, but can never introduce a new config, endpoint, or secret.

To make a `review:gpt-5.5` label "just work", name a config `gpt-5.5`. Selection is **by config name only**, never a bare model string (a model alone underdetermines engine, endpoint, and credential). Add `labeled` to your workflow's `on.pull_request.types` so a freshly added label triggers a re-review.

### Failover

When `fallback` is set, the selected config plus the rest of that list form the failover chain. A **transient** error (429 / rate-limit / quota / 529) retries the same config up to 3× (honoring `Retry-After`), then advances to the next config immediately; an exhausted chain backs off and sweeps again until the retry budget is spent — the smaller of 60 minutes and the time remaining in `TIME_BUDGET_MINUTES` (retry sleeps, including a server's `Retry-After`, are clamped to that remainder too, so a rate-limited run can never sleep past its own deadline). A **non-transient** error (bad output, validation failure, spawn error) throws immediately with no failover. The submitted review's footer names the config that actually produced it, so a failover is always visible.

## Preflight diagnostic

Before spawning the engine, the action runs a cheap connectivity + auth probe against the selected endpoint (a single `max_tokens: 1` request, ~1s). A wrong/expired credential or unreachable endpoint **fails fast with a precise cause** in the log instead of failing cryptically inside the agent. With a failover chain, the run proceeds as long as *any* config is reachable; unhealthy configs are logged as warnings.

## Session transcript

Every review run captures the **full session** of every engine attempt — the exact prompt sent to the engine, the raw output stream (claude-code runs `stream-json --verbose` so **thinking and tool calls** are included), and stderr. There is no flag to enable; it is always on. Each attempt's transcript is surfaced two ways:

- **In the Actions log** — inside a collapsible `🛠️ Session transcript` group, so you can click into the workflow run and read the entire prompt/response/thinking flow with no extra setup.
- **As a file** under `$RUNNER_TEMP/agent-review-transcripts/`, exposed via the action's `transcript-dir` **output**. Add one `actions/upload-artifact` step to archive the session as a downloadable artifact on **every** run — including failed attempts (`if: always()`):

```yaml
      - uses: promptctl/copirate-code-review-agent@v1
        id: review
        with:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}

      - if: always() && steps.review.outputs.transcript-dir != ''
        uses: actions/upload-artifact@v4
        with:
          name: review-session-transcript
          path: ${{ steps.review.outputs.transcript-dir }}
          if-no-files-found: ignore
```

The transcript dumps the engine's own raw streams verbatim — it is not a reconstructed narrative. The API key is never part of a transcript. This is the first place to look when a review seems shallow: if the `RAW STDOUT` section shows no `Read`/`Grep`/`Glob` tool calls, the engine reviewed only the inline diff without exploring the repo.

## Cost reporting

Every review reports its estimated USD cost in the attribution footer and the run log (tokens × a hand-maintained price table). A model with no table entry renders cost as `unknown` (tokens still shown) and logs a warning. Costs are estimates, never billed charges.

**A review is paid for in one of two ways, and the two are never added together.** A per-token API provider (`codex`, `zai`, `deepseek`) costs real dollars. `PROVIDER: claude-subscription` costs plan quota — no money changes hands — but Claude Code still reports what those tokens *would* have cost at Anthropic list price, and that figure is worth having: it is how you answer "is the subscription cheaper than the API bill, and how much of the plan am I using?"

So a subscription review reports its list price everywhere a cost is reported, labelled as what it is:

```
Not billed (Claude subscription) · $18.4100 at Anthropic list price · 12,231,000 in / 82,000 out tokens · claude-code/claude-sonnet-5 · est. · PR list-price total $63.5900 across 4 rounds
```

and it contributes **$0.00** to spend. Concretely:

- `DAILY_BUDGET_USD` rations dollars only. A day of subscription reviews leaves the whole budget available — the gradient never throttles against money nobody spent.
- The daily ledger still records every subscription review (its consumption stays visible), under a separate list-price roll-up that the spend total cannot read.
- A PR that ran some rounds on an API key and some on the subscription reports **two** totals side by side, never one blended number.

If Claude Code reports no list price for a subscription run, that is stated as unavailable and logged — never as `$0.00`, which would read as "we know it was free."

## Architecture

The reviewer **judges** read-only; the action **transports** the result. The engine's only output channel is a private MCP collector tool, so it can't post to GitHub itself — findings become typed, schema-validated records that the action validates and submits. For internals (engine adapters, the line-anchor invariant, host transports, config isolation), see [`CLAUDE.md`](CLAUDE.md) and `src/`.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). One fix/feature per PR, against `main`.

## License

MIT. See [LICENSE](LICENSE).
