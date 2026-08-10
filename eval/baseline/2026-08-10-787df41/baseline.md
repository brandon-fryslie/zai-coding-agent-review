# Eval baseline — 787df41 (2026-08-10)

Frozen distribution of must-find recall for the golden case suite on `main` at commit `787df41073726b0d09baa506bfe6ea8c4023e3c3`.
This is the reference the compare gate (`copirate-eval-harness-2fk.5`) measures a candidate engine change against.

- **Engine (pinned):** `deepseek` / `deepseek-v4-pro`
- **Matcher:** `llm/deepseek-v4-flash`
- **Repeats (N):** 5 per case
- **PRIMARY GATE — pooled inventory must-find recall:** 22% (22/100 across all 5×4 runs, against each case's pooled multi-round inventory); gate floor **14%** (~2σ lower bound). A candidate below the floor is degraded.
- **Frozen-round pooled must-find recall:** 21% (16/75) — continuity diagnostic, comparable with pre-inventory baselines; not a gate.
- **Suite mean of case means:** 25% (informational — the gate is the pooled inventory rate above, not this average)
- **Cost:** $3.4121 total across 20 costed run(s), ≈ $0.6824 per full suite run (all cases once).

## Per-case must-find recall band (diagnostic)

These bands localize *which* case moves a pooled regression; they are not independent gates (per-case means are too noisy at these denominators — see the rule). "inventory" spans every review round of the source PR; "frozen" is the single frozen round.

| case | inventory recall (mean / min / max) | diag. floor | per-run inventory | frozen recall (mean) | per-run frozen | noise (mean) | cost/run (est.) |
|------|-------------------------------------|-------------|-------------------|----------------------|----------------|--------------|-----------------|
| `cc-candybar-150-transcript-perf` | 12% / 0% / 30% | 0% | 1/10 · 1/10 · 0/10 · 3/10 · 1/10 | 9% | 1/7 · 1/7 · 0/7 · 1/7 · 0/7 | 2.2 | $0.2005 |
| `copirate-93-dependency-diff` | 30% / 0% / 50% | 0% | 2/4 · 2/4 · 0/4 · 1/4 · 1/4 | 27% | 1/3 · 2/3 · 0/3 · 0/3 · 1/3 | 2.0 | $0.1630 |
| `laws-4-eval-tasks` | 10% / 0% / 50% | 0% | 1/2 · 0/2 · 0/2 · 0/2 · 0/2 | 10% | 1/2 · 0/2 · 0/2 · 0/2 · 0/2 | 2.8 | $0.0759 |
| `links-317-dolt-telemetry` | 45% / 25% / 75% | 25% | 1/4 · 2/4 · 1/4 · 3/4 · 2/4 | 53% | 1/3 · 2/3 · 1/3 · 2/3 · 2/3 | 3.2 | $0.2431 |

## Degradation rule

PRIMARY GATE (pooled): the suite is DEGRADED when a candidate's pooled inventory must-find recall — total inventory must-finds found across all N×cases runs ÷ total inventory must-find opportunities, where a case's inventory pools every distinct must-find from all of its source PR's review rounds that exists in the frozen material — falls below this baseline's pooled gate floor (the baseline pooled rate minus a ~2σ binomial sampling margin). Pooling across runs is used because per-case recall means are too noisy to gate on at these tiny denominators. The frozen-round pooled rate and the per-case bands below are DIAGNOSTICS — they localize which case moved — not independent gates.

Mechanically: `candidate.suite.pooledInventoryMustFind.rate < 14%` (this baseline's `suite.pooledInventoryMustFind.gateFloor`) ⇒ the suite is DEGRADED.

