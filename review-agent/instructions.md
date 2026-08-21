<reviewer-charter>
# THE STRUCTURAL LENS

Your review task instructions — the prompt you are given for each review — tell you *what* to hunt
(bugs, edge cases, breakage, security, and the rest, correctness first), how to prioritize, and how to
write each finding. Follow them; they are authoritative for how you review. This document is the
secondary structural lens they refer to: the architectural laws.

The laws are **real but secondary** — correctness and safety outrank how the code is *shaped*, so hunt
bugs first and apply this lens after. You do not decide what blocks the merge: every recorded finding
requests changes, so record a finding only when the code should actually change. Flag a genuine
structural problem that will cost maintainers — record it, cite its `[LAW:token]`, and name the fix —
rather than withholding it. Do not manufacture law findings to fill a review — if the change is correct
and safe, a short summary is the right answer.

The core idea in one line: **make each piece of code do one thing, tell the truth about what it does, and push messiness (effects, ordering, branching) to the edges.** Everything below is a specific, checkable version of that.

---

## How code is shaped

**`[LAW:decomposition]`** — Each function/module does ONE thing. If you describe what it does and need the word "and," split it.
- Violation looks like: `colorOddRows()` (selecting *and* coloring), a function that fetches *and* parses *and* renders, a name like `processAndSave`.
- Fix: split into one-thing pieces that a caller combines.

**`[LAW:composability]`** — A good piece "does one thing, completely, asking nothing." It works in any caller without modification.
- Violation looks like: logic hardcoded for one caller (`if (row % 2)` baked inside instead of a `predicate` argument); a piece that can't run until you hand it a giant config.
- Fix: lift caller-specific choices out as parameters/values.
- Bad: `function colorOddRows(grid) { for (r of grid) if (r.index % 2) color(r) }`
- Good: `rows.filter(isOdd).forEach(color)` — `filter` asks for a predicate and serves everyone.

**`[LAW:locality-or-seam]`** — A change in one place must not force edits in unrelated places. If it does, a boundary is missing.
- Violation looks like: editing five files to add one field; ripple edits across modules that shouldn't know about each other.
- Fix: add an interface/adapter at the boundary first, then change behind it.

**`[LAW:one-way-deps]`** — Dependencies point one direction. No cycles. No child calling its parent.
- Violation looks like: module A imports B and B imports A; a low-level util reaching back up into app logic.
- Fix: extract the shared thing into its own module both can depend on.

---

## Tell the truth (representation)

**`[LAW:types-are-the-program]`** — Make illegal states impossible to represent in the type, not impossible by checking at runtime. Pick types where every legal value is allowed and every illegal value won't compile.
- Violation looks like: `status: string` when it's one of four values (use a union/enum); a struct where two fields must agree but nothing enforces it; `any`.
- Fix: tighten the type until the bad state can't be written. If the body needs a guard or a branch, the type upstream is too loose — fix the type, not the body.
- Rule of thumb: **if implementation feels hard or branchy, the types are wrong.** Stop and fix the type.

**`[LAW:one-source-of-truth]`** — Each fact lives in exactly ONE place. Everything else is derived from it.
- Violation looks like: the same value stored in two fields that can drift; a cache treated as authoritative; copy-pasted constants.
- Fix: pick the canonical source; derive the rest.

**`[LAW:single-enforcer]`** — Each rule (auth, validation, formatting) is enforced in ONE place.
- Violation looks like: the same validation check repeated at five callsites.
- Fix: enforce once at the boundary; delete the duplicates.

**`[LAW:comments-explain-why-only]`** — Comments say WHY. Never WHAT the code does.
- Violation looks like: `// loop over users` above a user loop; comments naming variables, counts, or callers.
- Fix: delete WHAT-comments on sight. Keep only comments explaining a non-obvious reason.

---

## Variability goes in values, not branches

**`[LAW:dataflow-not-control-flow]`** — The same code should run every time; what changes is the DATA flowing through it, not WHICH code runs.
- **Strongest signal:** if you describe how your solution works using "if," "and," "when," "skip," or "only," it is probably wrong.
- Violation looks like: `if (mode === 'A') doA() else doB()` scattered everywhere; an operation guarded so it sometimes runs and sometimes doesn't.
- Fix: make the operation always run; let the data decide the result.

**`[LAW:one-type-per-behavior]`** — Same behavior, different name = ONE type with config, not many types.
- Violation looks like: `HandlerA`, `HandlerB`, `HandlerC` that differ only in a constant.
- Fix: one `Handler` taking that constant as data.

**`[LAW:no-mode-explosion]`** — Every new flag/option needs a reason and a removal plan. The default path stays the main path.
- Violation looks like: functions with five boolean flags; `2^n` behavior combinations no one tests.
- Fix: prefer one value/argument over a new mode. Cap the flags.

**`[LAW:no-defensive-null-guards]`** — Only null-check at real boundaries (user input, network, DB). Don't guard against nulls that "shouldn't happen."
- Violation looks like: `if (x) { doWork() }` with no `else` — this silently skips work and hides bugs.
- Fix: if `x` can't be null, make the type non-nullable upstream. If it can, handle every case explicitly. Never silently skip.

---

## The outside world

**`[LAW:effects-at-boundaries]`** — A function either COMPUTES or ACTS (writes files, calls network, mutates, reads clock/random) — not both. Keep the core pure; do effects at the edges.
- Violation looks like: a calculation that also writes to the DB in the middle; business logic interleaved with `print`/`fetch`/`fs.write`.
- Fix: pure core returns *what to do*; a thin outer layer does it.

**`[LAW:no-ambient-temporal-coupling]`** — Don't depend on hidden ordering or timing. If B must run after A, make that explicit in state or the API.
- Violation looks like: `sleep(100)` to "let things settle"; code that breaks if you reorder two calls; relying on init happening "somewhere earlier."
- Fix: encode the order as explicit state or pass the dependency directly.

---

## Stay honest

**`[LAW:no-silent-failure]`** — Failures are LOUD. Never hide an error or fall back silently to something that changes the meaning.
- Violation looks like: `2>/dev/null`, `|| true`, `try {...} catch {}` with an empty body, a fallback that quietly returns different data when the real source fails.
- Fix: let it fail with a clear message. If the main path fails, stop and say so.

**`[LAW:verifiable-goals]`** — "Done" needs a concrete check a machine can run. Verify it yourself before claiming done.
- Violation looks like: "it's built, now you test it"; declaring success with no check run.
- Fix: define what success looks like (builds clean, tests pass, no errors in logs), run it, report the result. Ask the user only as a last resort.

**`[LAW:behavior-not-structure]`** — Tests check WHAT the code does (its contract), not HOW it's built.
- Violation looks like: a test that breaks when you rename an internal function; a test that only passes if you keep deleted code.
- Fix: assert outputs and contracts. Update or delete tests that lock in implementation.

---

## Quick checklist
Cut into one-thing pieces (`[LAW:decomposition]`) that work anywhere (`[LAW:composability]`). Make illegal states uncompilable (`[LAW:types-are-the-program]`); one home per fact (`[LAW:one-source-of-truth]`), one enforcer per rule (`[LAW:single-enforcer]`). Variability in values, not branches (`[LAW:dataflow-not-control-flow]`) — watch for if/and/when/only. Effects and ordering at the edges (`[LAW:effects-at-boundaries]`, `[LAW:no-ambient-temporal-coupling]`). Fail loud (`[LAW:no-silent-failure]`); verify done (`[LAW:verifiable-goals]`). When the body feels hard, fix the type.
</reviewer-charter>