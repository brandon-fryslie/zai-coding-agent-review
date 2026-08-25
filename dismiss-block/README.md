# CoPirate Dismiss Block

A second, small action shipped from this same repo — **Gitea only**. It exists because
Gitea's dismiss-review endpoint requires the dismissing account to hold repo-*Admin*,
while the review action's own `GITHUB_REVIEW_TOKEN` is deliberately kept at collaborator
level `write` (measured live against Gitea 1.27.1: the access that is enough to *post* a
review 403s trying to *dismiss* one, and no token scope substitutes for the role). Rather
than adding a Gitea-only input to [the review action](../README.md) — which is `uses:`'d
by GitHub repos that will never hit this failure mode — that credential lives here, in an
action Gitea workflows opt into as an extra step and GitHub workflows never reference.

See the review action's [round-cap section](../README.md#a-skipped-run-says-so-on-the-pr)
for the full failure this exists to fix: a round-cap-blocked `REQUEST_CHANGES` that
outlives the fix it was blocking, deadlocking a PR against `block_merge_on_rejected_reviews`
branch protection.

## What it does

Reads the PR's prior reviews the same way the review action does and releases — with
`DISMISS_TOKEN` — the merge block the review action left behind when it **gave up on the
PR**. Two things must both hold, and the second is what keeps this safe to run
unconditionally:

1. one of the review action's **own** reviews is still marked as blocking, and
2. the review action has announced it will not revisit this PR — its round-cap
   `NOT REVIEWED` notice is the newest thing it has left on the PR.

Without (2) this action would dismiss *live* blocks. A `REQUEST_CHANGES` posted seconds
earlier for real, unaddressed findings is "still blocking" in exactly the same way as a
round-cap leftover, and the wiring below puts this step in front of that review on every
push — so releasing on (1) alone would defeat `block_merge_on_rejected_reviews` on
precisely the pushes it exists for. Gating on the notice reads the review action's own
decision off the PR instead of guessing at it, and it also makes the dismissal message
(which points readers at that notice) true by construction: no notice, no dismissal.

So a PR the reviewer still intends to revisit is a no-op, as is one with nothing
outstanding — safe as an unconditional extra step on every PR event, not just capped ones.
It never reviews anything, spawns no engine, and posts no verdict; a refused dismissal
(e.g. `DISMISS_TOKEN` not actually Admin) reds this step's own run and posts the same
`⚠️ **BLOCK NOT RELEASED**` notice the review action would have posted had it held this
credential itself.

## Inputs

| Input | Default | Description |
|---|---|---|
| `GITHUB_TOKEN` | `${{ github.token }}` | Token for reading the PR and its reviews. |
| `GITHUB_REVIEW_TOKEN` | — | The review step's own bot identity (e.g. `secrets.COPIRATE_REVIEW_TOKEN`); used only to post a failure notice if the dismissal is refused. Pass the same value given to the review step. |
| `DISMISS_TOKEN` | — (required) | Token for a **separate**, repo-Admin account. Used for exactly one call — dismissing the outstanding review — and nothing else this action does. |
| `PR_NUMBER` | from event | PR number. Auto-detected on `pull_request` events; pass explicitly on others (e.g. `workflow_run`). |
| `HEAD_SHA` | from event | Head SHA a failure notice anchors to. Auto-detected on `pull_request` events. |
| `ZAI_REVIEWER_NAME` | `CoPirate Code Review` | Name shown in any failure-notice header. Pass the same value given to the review step so both voices match. |

## Usage (Gitea workflow, as a second step after the review)

```yaml
      - name: CoPirate Code Review
        uses: https://gitea.sanctuary.gdn/brandon-fryslie/copirate-code-review-agent@v1
        with:
          # ...review inputs...
          GITHUB_REVIEW_TOKEN: ${{ secrets.COPIRATE_REVIEW_TOKEN }}

      - name: CoPirate Dismiss Block
        if: always()
        uses: https://gitea.sanctuary.gdn/brandon-fryslie/copirate-code-review-agent/dismiss-block@v1
        with:
          GITHUB_REVIEW_TOKEN: ${{ secrets.COPIRATE_REVIEW_TOKEN }}
          DISMISS_TOKEN: ${{ secrets.COPIRATE_DISMISS_TOKEN }}
```

`if: always()` matters: the review step may have already failed or skipped (a round-cap
notice, a red run), and this step's whole purpose is to run anyway and clean up whatever
block is still outstanding regardless of how the review step's own run concluded.

## Why not just widen the review action's own bot to Admin?

That was the other option considered (and rejected) for this credential: keep one
identity, grant `copirate-bot` repo-Admin instead of `write` everywhere. It costs zero new
resources — no second Gitea user, no second Vault secret, no second Actions secret — but
the identity that reads every diff and posts on every PR then holds Admin (repo settings,
webhooks, branch protection) for the whole time it runs, not just the one moment it needs
to dismiss a review. This design keeps that exposure narrower — a separate identity, used
by a separate action, invoked only when something needs releasing — at the cost of the
extra plumbing recorded here and in `terraform/gitea` on the consuming side (home-infra).
