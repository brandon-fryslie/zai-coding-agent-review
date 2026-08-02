# Eval baseline — dc87ee0 (2026-08-01)

Frozen distribution of must-find recall for the golden case suite on `main` at commit `dc87ee0ec4fdf590839c5a89a14d98e7a00d584b`.
This is the reference the compare gate (`copirate-eval-harness-2fk.5`) measures a candidate engine change against.

- **Engine (pinned):** `deepseek` / `deepseek-v4-pro`
- **Matcher:** `llm/deepseek-v4-flash`
- **Repeats (N):** 5 per case
- **PRIMARY GATE — pooled must-find recall:** 19% (14/75 across all 5×4 runs); gate floor **10%** (~2σ lower bound). A candidate below the floor is degraded.
- **Suite mean of case means:** 19% (informational — the gate is the pooled rate above, not this average)
- **Cost:** $3.4762 total across 20 costed run(s), ≈ $0.6952 per full suite run (all cases once).

## Per-case must-find recall band (diagnostic)

These bands localize *which* case moves a pooled regression; they are not independent gates (per-case means are too noisy at these denominators — see the rule).

| case | must-find recall (mean / min / max) | diag. floor | per-run must-find | noise (mean) | cost/run (est.) |
|------|-------------------------------------|-------------|-------------------|--------------|-----------------|
| `cc-candybar-150-transcript-perf` | 14% / 0% / 43% | 0% | 1/7 · 3/7 · 0/7 · 0/7 · 1/7 | 4.0 | $0.2120 |
| `copirate-93-dependency-diff` | 13% / 0% / 33% | 0% | 0/3 · 1/3 · 1/3 · 0/3 · 0/3 | 1.4 | $0.1608 |
| `laws-4-eval-tasks` | 10% / 0% / 50% | 0% | 0/2 · 0/2 · 1/2 · 0/2 · 0/2 | 5.2 | $0.0784 |
| `links-317-dolt-telemetry` | 40% / 33% / 67% | 33% | 1/3 · 1/3 · 1/3 · 2/3 · 1/3 | 3.6 | $0.2440 |

## Degradation rule

PRIMARY GATE (pooled): the suite is DEGRADED when a candidate's pooled must-find recall — total must-finds found across all N×cases runs ÷ total must-find opportunities — falls below this baseline's pooled gate floor (the baseline pooled rate minus a ~2σ binomial sampling margin). Pooling is used because per-case recall means are too noisy to gate on at these tiny denominators (run-to-run spread exceeds the mean for 3 of 4 cases; 3 per-case floors are 0%). The per-case bands below are DIAGNOSTICS — they localize which case moved — not independent gates.

Mechanically: `candidate.suite.pooledMustFind.rate < 10%` (this baseline's `suite.pooledMustFind.gateFloor`) ⇒ the suite is DEGRADED.

