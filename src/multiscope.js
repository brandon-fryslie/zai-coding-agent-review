'use strict';
const { produceReview, retryTransientSpawn, sleep, TRANSIENT_RETRY_BUDGET_MS } = require('./failover');
const { DeadlineExceededError, BUDGET_REMEDY, remainingMs } = require('./deadline');
const { defaultEffortProfile, maxTier } = require('./effort');
const { dedupeFindings, dedupeAssessments, parseScopeValue } = require('./review');
const { sumCost, emptyTokens, addTokens } = require('./usage');
const { renderDependencyDiffNote } = require('./dependency-diff');
const { NO_EXCLUSIONS, excludedPathList } = require('./diff');
const {
  buildReviewInput,
  buildRepoReviewInput,
  buildPrScoutInput,
  buildRepoScoutInput,
} = require('./prompt');

// The adaptive multi-scope review engine, shared by both review modes (PR and whole-repo).
//
// [FRAMING:parts-and-seams] A review IS one shape regardless of material or sink: a SCOUT plans the
// review (one survey spawn that emits a list of scopes), then one WORKER per scope judges it (one
// review spawn each), then the workers' findings + usage AGGREGATE into a single review value. The
// worker layer additionally re-runs as CONVERGENCE SWEEPS over the same scopes — each shown the
// findings already recorded, hunting only for what is missing — until a pass adds nothing new or the
// effort profile's sweepCap is reached (zai-recall-upr.2). PR and repo differ only in two values they
// already differ on elsewhere — the `material` (what the scout surveys and what each worker reviews)
// and the `sink` (how findings leave). [LAW:one-type-per-behavior]
//
// Adaptivity is the GROUPING, not a counted threshold: the scout groups the change by concern and
// follows the import edges it actually crosses, so a one-concern change yields one scope and a
// many-concern change yields many — the same worker pool runs over a list of length 1 or 20,
// identically. There is no "is it big" branch anywhere. [LAW:dataflow-not-control-flow]
//
// [LAW:no-ambient-temporal-coupling] Retry lives at TWO nested layers, each owned by failover.js so
// this module reimplements no retry timing. Inner: every engine spawn (the scout and each worker) is
// wrapped in retryTransientSpawn, so a single transient blip in one of N concurrent workers is
// absorbed in place — the sibling workers' already-recorded findings are never discarded by re-running
// the whole pass. Outer: the WHOLE pass (scout → workers → aggregate) is still ONE attempt of
// failover.produceReview per config, so a transient that PERSISTS past a spawn's inner retries
// escalates to config-level failover/budget as before. Both layers are fail-loud (a scope is never
// dropped); the run only reds when a transient genuinely survives both. [LAW:no-silent-failure]

// [LAW:types-are-the-program] A scope is the strongest true theorem: a named focus, nothing more.
// There is deliberately NO `kind` discriminator — module scopes and boundary scopes are reviewed by
// the identical worker, so the difference lives entirely in the focus TEXT, never in a branch. The
// scout records each scope through the add_scope collector tool, so scopes arrive as typed,
// schema-validated values (parseScopeValue, in src/review.js) — never parsed from the model's prose.
// [FRAMING:representation] That is why this module no longer extracts a JSON array from text: the
// representation a machine checks (the tool schema) replaced the representation we hoped to recover
// (brackets in free text), and the whole class of prose-parsing bugs went with it.

// [LAW:effects-at-boundaries] Pure: compose the single focus string a worker receives — the scout's
// structural context (when present) plus this scope's name and focus. The material turns it into the
// engine prompt (a PR worker's CONCENTRATE block, a repo worker's scope focus).
function workerFocusText(scope, context) {
  const prefix = context ? `Structural context from the planning pass:\n${context}\n\n---\n\n` : '';
  return `${prefix}${scope.name} — ${scope.focus}`;
}

// [LAW:one-source-of-truth] "Same finding" is decided by dedupeFindings in src/review.js — one dedup
// over the MERGED findings (not per worker), since two adjacent scopes can both touch a shared file.
// It is imported, never re-implemented, so the pre-anchor merge here and the post-anchor snap-collapse
// in partitionFindings share one key. [LAW:single-enforcer]

// [LAW:effects-at-boundaries] Pure: sum the per-spawn Usage values into one. Token counts always add.
// [LAW:single-enforcer] Summing COSTS is delegated to sumCost (src/usage.js), the one owner of the
// "never add across bases" rule — this module knows how to add tokens, not what a dollar means.
// The cost basis is uniform by construction here (every spawn in a pass runs on ONE config), so all
// costs share the same model and the same basis; sumCost still resolves the mixed case as a value.
// [LAW:no-silent-failure] no spawn's cost is silently dropped: one unpriced spawn makes the whole
// sum unpriced, carrying that spawn's reason.
// usage === null (no spawn record at all) is excluded; all-null sums to null, matching the
// single-spawn behavior the cost renderer already handles. A spawn whose engine reported nothing
// still carries its host-stamped span (zai-timing-31d.4), so its record arrives with tokens and
// cost ABSENT: it contributes its span to the envelope and nothing to the token or cost folds,
// and a pass where NO spawn reported tokens sums them to null — the renderer's "engine reported
// no token usage" value, never a fabricated zero. [LAW:parse-dont-validate]
function sumUsage(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  const tokens = present.map(u => u.tokens).filter(Boolean);
  const costs = present.map(u => u.cost).filter(Boolean);
  return {
    tokens: tokens.length > 0 ? tokens.reduce(addTokens, emptyTokens()) : null,
    // The pass's SPAN is the envelope of its spawns' spans — earliest start, latest end — which is
    // the honest answer for a scheduler that runs workers in waves: the pass occupied that window,
    // and a restatement that needs to know which price epoch applies can see whether the window sits
    // inside one or straddles a boundary. Collapsing it to a single instant would hide the straddle.
    // [LAW:no-silent-failure] A spawn that recorded no span contributes none, exactly as a spawn
    // that recorded no usage contributes no tokens.
    span: sumSpan(present.map(u => u.span)),
    // Absent costs (engine reported nothing) are excluded from the fold exactly as their tokens
    // are; an UNPRICED cost is a present value and still poisons the sum, as before.
    cost: costs.length > 0 ? sumCost(costs) : null,
  };
}

// [LAW:effects-at-boundaries] Pure: fold spans by min-start/max-end. ISO-8601 UTC timestamps are
// lexicographically ordered, so string comparison IS chronological order and no Date round-trip is
// needed. All-absent folds to undefined — a recorded absence, never a fabricated window.
function sumSpan(spans) {
  const present = spans.filter(Boolean);
  if (present.length === 0) return undefined;
  return {
    from: present.reduce((min, s) => (s.from < min ? s.from : min), present[0].from),
    to: present.reduce((max, s) => (s.to > max ? s.to : max), present[0].to),
  };
}

// [LAW:effects-at-boundaries] Pure: the aggregated review summary. It names every scope reviewed and
// carries each worker's own summary verbatim — never the scout's raw JSON, which stays out of the
// author-facing text. [LAW:one-source-of-truth]
// workerResults are the INITIAL pass's — the judgments of record. Each convergence sweep contributes
// one line stating what it added; its workers' own summaries are mostly "nothing new" narration, so
// their findings flow to the merged set while the sweep line carries the summary-level story. sweeps
// is a value: [] (sweepCap 0, or the shape predating sweeps) renders nothing. [LAW:dataflow-not-control-flow]
// budget is the time-budget outcome: the default (not exhausted, nothing unreviewed) renders nothing,
// so a run without a deadline — and a run that fit its deadline — is byte-identical to before.
// [LAW:no-silent-failure] When the budget DID bite, the summary leads with the truth: the headline
// count names only the scopes actually reviewed, the unreviewed ones are listed by name, and a
// curtailed convergence is called out — a partial review must never read like a clean bill.
function composeSummary(scopes, workerResults, sweeps = [], budget = { exhausted: false, unreviewedScopes: [] }) {
  const unreviewed = new Set(budget.unreviewedScopes);
  const reviewed = scopes.filter(s => !unreviewed.has(s.name));
  // [LAW:parse-dont-validate] Nothing is flattened here. A scope's name comes stamped single-line from
  // parseScopeValue and a worker's summary from parseReviewValue, so neither can break this
  // line-structured summary. This sink previously flattened the name and NOT the summary — the exact
  // shape of bug that call-site discipline produces, and the reason the rule moved to the boundary.
  const lines = [`Reviewed ${reviewed.length} scope(s): ${reviewed.map(s => s.name).join(', ')}.`, ''];
  for (const r of workerResults) {
    lines.push(`**${r.name}** — ${r.summary || '(no summary)'}`);
  }
  for (const [i, s] of sweeps.entries()) {
    // [FRAMING:representation] A curtailed sweep must never render as convergence: "added nothing
    // because it was killed" and "searched and found nothing" are different facts.
    lines.push(`**convergence sweep ${i + 1}** — ${s.curtailed
      ? `cut short by the time budget after ${s.added} new finding(s).`
      : s.added === 0 ? 'nothing new; the review converged.' : `${s.added} new finding(s).`}`);
  }
  if (budget.exhausted) {
    lines.push(budget.unreviewedScopes.length > 0
      ? `⏳ **Time budget exhausted** — ${reviewed.length} of ${scopes.length} scope(s) were reviewed; `
        + `NOT reviewed: ${budget.unreviewedScopes.join(', ')}. The findings above cover only the reviewed scopes.`
      : '⏳ **Time budget exhausted** — every scope was reviewed, but convergence sweeps were cut short; '
        + 'late-round findings may be missing.');
  }
  return lines.join('\n');
}

// [LAW:dataflow-not-control-flow] A bounded-concurrency worker pool that is FAIL-LOUD: the first error
// stops new work and is rethrown after in-flight workers settle, preserving its type (a TransientError
// stays a TransientError so failover can classify it). [LAW:no-silent-failure] this is the deliberate
// inverse of swallowing a failed scope into an empty-finding result — an unreviewed scope must never
// pass as a clean one.
//
// [LAW:types-are-the-program] The pool returns one OUTCOME per scope, in scope order — a discriminated
// value: { status: 'reviewed', result } | { status: 'unreviewed', usage }. 'unreviewed' is the time
// budget's planned degradation, reached two ways that differ only in what was burned: shouldStart()
// said no before the spawn (the budget was already spent — usage null, nothing ran), or the spawn was
// killed at the deadline mid-flight (DeadlineExceededError — usage is the span-only record of the
// wall clock it burned, which the caller folds into the pass total; zai-timing-31d.4). Both are
// absorbed HERE, scope by scope, so sibling workers' already-earned
// results survive — the deadline must never take the fail-loud path that discards the whole batch.
// Every other error still aborts the batch exactly as before; the caller decides what 'unreviewed'
// means for its layer (a pass-0 coverage gap vs a merely-curtailed sweep).
async function runScopeWorkers({ scopes, runOne, maxConcurrent, shouldStart = () => true }) {
  const outcomes = new Array(scopes.length);
  let next = 0;
  let firstError = null;
  async function lane() {
    while (next < scopes.length && !firstError) {
      const i = next++;
      if (!shouldStart()) {
        // Refused before anything spawned: no time was burned, so there is no usage to carry.
        outcomes[i] = { status: 'unreviewed', usage: null };
        continue;
      }
      try {
        outcomes[i] = { status: 'reviewed', result: await runOne(scopes[i]) };
      } catch (e) {
        if (e instanceof DeadlineExceededError) {
          // A killed spawn's burned time still counts (zai-timing-31d.4): runEngine stamps the span
          // on the error, and it rides out of here as a span-only usage record — the same shape a
          // token-less success produces, folded by the same sumUsage. [LAW:one-type-per-behavior]
          // e.span is absent when the deadline gate refused the spawn outright: nothing ran, no usage.
          outcomes[i] = { status: 'unreviewed', usage: e.span ? { span: e.span } : null };
          continue;
        }
        firstError = firstError || e;
      }
    }
  }
  const laneCount = Math.min(Math.max(1, maxConcurrent), scopes.length);
  await Promise.all(Array.from({ length: laneCount }, lane));
  if (firstError) throw firstError;
  return outcomes;
}

// One scope worker: a single review spawn on this config, focused on one scope. [LAW:composability]
// It does one thing — review one scope — and returns its raw findings + summary + usage as a value.
// `spawn` is the transient-retry-wrapped engine spawn (see runMultiScopePass), so a blip retries THIS
// worker in place rather than failing the whole pass. [LAW:decomposition]
// priorFindings and labelPrefix are the convergence-sweep values (zai-recall-upr.2): the initial pass
// runs with [] and '' (byte-identical prompt and logs), a sweep with the cumulative found list and a
// 'sweep N ' prefix — one worker, varied by values, never a sweep mode. [LAW:one-type-per-behavior]
async function runScopeWorker({ scope, context, material, spawn, log, priorFindings = [], labelPrefix = '' }) {
  const focusText = workerFocusText(scope, context);
  // [LAW:decomposition] The worker reads its scope's assigned files in full, not the whole changed set;
  // the material threads scope.files into the read instruction. Repo material ignores it (no diff).
  const buildPromptFor = (toolNames) => material.buildWorkerPrompt(focusText, toolNames, scope.files, priorFindings);
  const label = `${labelPrefix}scope '${scope.name}'`;
  log(`${label} starting…`);
  // [LAW:dataflow-not-control-flow] Every record kind the spawn produced flows through this seam
  // unbroken — findings AND dependency assessments (the go.mod-owning worker's per-module judgments).
  // Dropping assessments here would silently strip the whole feature: the aggregation's `|| []` fallback
  // would fire on every worker and every bump would render "unassessed". [LAW:no-silent-failure]
  const { summary, findings, assessments, usage } = await spawn(buildPromptFor, label);
  log(`${label} done — ${findings.length} finding(s)`);
  return { name: scope.name, summary, findings, assessments, usage };
}

// [LAW:effects-at-boundaries] Pure: given the scout's planned scopes and the changed paths the plan was
// meant to cover, return the scope list the workers actually run — the plan, plus ONE synthetic
// 'unassigned files' scope holding any changed path no scope claimed in its `files`. [LAW:verifiable-goals]
// The scout prompt asserts "every changed file belongs to exactly one scope"; the scope schema now carries
// that assignment as DATA (scope.files), so coverage is exact SET MEMBERSHIP, not a text-match heuristic.
// [LAW:types-are-the-program] the representation a machine checks (the assigned-file set) replaced the one
// we hoped to recover from prose (a path token mentioned somewhere in the focus), and the whole class of
// substring-collision bugs went with it — no more 'scope.js' ⊂ 'multiscope.js' false positives to guard.
//
// A dropped file is the most common weak-model planning slip: since sibling 598.2 stopped workers
// suppressing out-of-scope findings it is no longer invisible, but a file no scope claims gets no worker
// reading it in FULL — so the catch-all guarantees DEEP coverage, not merely non-zero coverage. A path
// the scout mis-typed (so it matches no changed file) simply lands in the catch-all and is read there:
// the sweep errs toward over-reading, never toward dropping. [LAW:no-silent-failure]
//
// [LAW:dataflow-not-control-flow] The sweep is a value flowing into the same worker pool, not a new
// engine branch: repo material carries changedPaths = [], so nothing is ever swept and the plan is
// returned unchanged — a no-op by construction, an empty value, not a mode. sweptPaths is returned so
// the caller can surface scout quality as an observable signal, never a silent correction. [LAW:no-silent-failure]
//
// withheldPaths is the third slip, and the one this boundary exists to make impossible rather than merely
// discourage. Naming the EXCLUDE_PATTERNS-withheld paths to the scout is what lets it avoid scoping them,
// and it is also the only reason it could ever name one: before it was told, those filenames were not in
// its material at all. A withheld path that survived into a scope would reach buildReviewInput's
// scopeFiles and render as "Read the complete content of THESE files" — the literal opposite of the same
// prompt's "Do not read these paths", decided in the worker's favour by whichever instruction it weighs
// harder. So the plan boundary strips it; the prompt's sentence is the request, this is the guarantee.
// [LAW:types-are-the-program]
//
// The predicate is the withheld set ITSELF, never "not in changedPaths". Those are two different facts —
// what this review covers vs. what is out of bounds — and the complement of the first is the second only
// in PR mode: repo material carries changedPaths = [] by design, so a complement-based check would strip
// every file of every scope on every repo run. [FRAMING:representation]
//
// A scope emptied by the strip is DROPPED, not passed through: buildReviewInput reads an empty scopeFiles
// as "no assigned files" and falls back to "read every changed file in full", so an empty scope would
// silently undo scope-bounded reads (c783325) — a cost regression wearing the shape of a safety check.
// Anything orphaned by a dropped scope is picked up by the catch-all below, because the strip runs BEFORE
// coverage is computed; no second coverage mechanism. [LAW:one-type-per-behavior]
function planScopes(scopes, changedPaths, withheldPaths = []) {
  const { scopes: planned, withheldAssignments } = withoutWithheldFiles(scopes, withheldPaths);
  const assigned = new Set(planned.flatMap(s => s.files));
  const sweptPaths = changedPaths.filter(p => !assigned.has(p));
  // [LAW:verifiable-goals] The scout promises each changed file appears in EXACTLY one scope. The sweep
  // catches the lower bound (a file in no scope); this catches the upper bound (a file in two+ scopes),
  // where two workers each read it in full — the redundant cost the whole change exists to remove. It is
  // surfaced as an observable value, not silently folded away by the Set above. [LAW:no-silent-failure]
  const seen = new Set();
  const recordedDup = new Set();
  const duplicatePaths = [];
  // `planned`, not `scopes`: a withheld path the scout put in two scopes is stripped from both, so it is
  // not a duplicate to warn about — it is not read by any worker at all. Reporting the pre-strip plan here
  // would describe a review that no longer exists. [FRAMING:representation]
  for (const p of planned.flatMap(s => s.files)) {
    if (seen.has(p) && !recordedDup.has(p)) {
      recordedDup.add(p);
      duplicatePaths.push(p); // first-seen order, each duplicate once — O(1) membership, O(n) overall
    }
    seen.add(p);
  }
  if (sweptPaths.length === 0) return { scopes: uniquelyNamed(planned), sweptPaths, duplicatePaths, withheldAssignments };
  // [LAW:single-enforcer] The catch-all is built through parseScopeValue like every scout-recorded
  // scope, so EVERY Scope value in the system carries the same single-line stamp — a hand-built one
  // would be the one object in the program whose fields skipped the boundary, which is precisely the
  // hole a "just construct it here" shortcut opens. [LAW:one-type-per-behavior]
  const catchAll = parseScopeValue({
    name: 'unassigned files',
    focus: `These changed files were not covered by the planned scopes: ${sweptPaths.join(', ')}. Review their changes fully.`,
    files: sweptPaths,
  }, 0);
  return { scopes: uniquelyNamed([...planned, catchAll]), sweptPaths, duplicatePaths, withheldAssignments };
}

// [LAW:decomposition] One job: remove the withheld paths from the plan and say which ones were there.
// The removals are returned, never merely dropped — a scout that keeps scoping withheld files is a signal
// about the prompt, and a silent strip would hide the very thing worth measuring. [LAW:no-silent-failure]
// No early return for the empty set — the loop already answers that question, and a guard would be a
// second answer to it. Identity is preserved at the END instead, keyed on what was actually removed
// rather than on what was passed in: a configured-but-unmatched withheld set strips nothing and must be
// as provably a no-op as an unconfigured one. Same shape as uniquelyNamed below, and the two together are
// what let planScopes hand back its own input when the scout's plan needed no reconciliation at all.
function withoutWithheldFiles(scopes, withheldPaths) {
  const withheld = new Set(withheldPaths);
  const withheldAssignments = [];
  const recorded = new Set();
  const kept = [];
  for (const scope of scopes) {
    const files = scope.files.filter(f => {
      if (!withheld.has(f)) return true;
      if (!recorded.has(f)) {
        recorded.add(f);
        withheldAssignments.push(f); // first-seen order, each path once, however many scopes claimed it
      }
      return false;
    });
    // Spread rather than parseScopeValue: every field here already crossed that boundary when the scout
    // recorded the scope, and `files` is a SUBSET of an already-stamped list — removing elements cannot
    // introduce an unstamped one. [LAW:single-enforcer] holds; there is no new value to parse.
    // EMPTIED BY THE STRIP, not merely empty. A scope the scout left unlisted arrives with files: []
    // straight from parseScopeValue (src/review.js) — a legal Scope this mechanism never touched — and
    // dropping it would make one scope's survival depend on whether some UNRELATED scope named a withheld
    // path, since `kept` is only returned when something was stripped at all. A strip must be inert on
    // everything it did not strip. [LAW:dataflow-not-control-flow]
    const emptiedByStrip = files.length === 0 && scope.files.length > 0;
    if (!emptiedByStrip) kept.push(files.length === scope.files.length ? scope : { ...scope, files });
  }
  // No path removed ⇒ no scope rewritten and none dropped, so `kept` is element-for-element `scopes`;
  // return the INPUT rather than the copy that merely matches it.
  return { scopes: withheldAssignments.length === 0 ? scopes : kept, withheldAssignments };
}

// [LAW:parse-dont-validate] A scope's name is its IDENTIFIER downstream — log lines, sweep labels,
// and the time budget's coverage bookkeeping (unreviewedScopes vs reviewed) all key on it — but the
// scout contract only promises non-empty, not unique. Stamp uniqueness once here at the plan
// boundary, so every name-keyed consumer inland is sound by construction: a repeated name (scout
// dupes, or a scout scope colliding with the 'unassigned files' catch-all) gets a deterministic
// ' (2)', ' (3)' suffix; the suffixed name is itself checked against the used set, so a scout that
// literally planned 'x' and 'x (2)' still comes out collision-free.
function uniquelyNamed(scopes) {
  const used = new Set();
  let renamed = false;
  const out = scopes.map(s => {
    let name = s.name;
    for (let n = 2; used.has(name); n++) name = `${s.name} (${n})`;
    used.add(name);
    if (name === s.name) return s;
    renamed = true;
    return { ...s, name };
  });
  // The collision-free case returns the INPUT array itself — the common path is a provable no-op,
  // not a fresh copy that merely looks like one.
  return renamed ? out : scopes;
}

// One full multi-scope pass for ONE config: scout → workers → aggregate. This is the produceOnce that
// failover.produceReview drives, so the whole pass is one attempt and retry/failover wraps it as a
// unit. Returns the same {summary, findings, usage} shape a single engine spawn used to return, so
// every downstream sink stays unchanged. [LAW:decomposition]
// `deadline` (epoch ms, null = no budget) and `now` (the injected clock, matching the sleepFn
// convention) are the wall-clock budget: the pass stops STARTING work — scope workers and sweeps —
// once the budget is spent, delivers everything already collected, and reports the coverage gap as
// data (unreviewedScopes, budgetExhausted). [LAW:no-ambient-temporal-coupling] the deadline is a
// value minted once at the run boundary, never a clock read scattered through callers.
async function runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, sweepCap, log, sleepFn = sleep, deadline = null, now = Date.now }) {
  // [LAW:no-silent-failure] A missing/malformed sweep bound must not decide anything by accident: an
  // undefined cap would make the convergence loop's `pass <= sweepCap` false on pass 0 and the review
  // would "succeed" having run NO workers at all. The bound comes from the effort profile (its one
  // source); a caller that lost it is a bug that fails loud here.
  if (!Number.isInteger(sweepCap) || sweepCap < 0) {
    throw new Error(`runMultiScopePass requires a non-negative integer sweepCap (got ${JSON.stringify(sweepCap)}); it comes from the effort profile.`);
  }
  const adapter = registry.get(config.engine);

  // [LAW:decomposition] Every engine spawn in this pass goes through one transient-retry seam, so a
  // single flaky request (a dropped socket, a 5xx) is absorbed in place — the scout and each worker
  // recover independently and a blip never re-runs the whole pass. An exhausted or non-transient error
  // still propagates, so config-level failover (produceReview) is unchanged. [LAW:one-source-of-truth]
  const spawn = (buildPromptFor, label) =>
    retryTransientSpawn(
      () => adapter.produceReview({ config, buildPromptFor, instructionsPath, deadline }),
      {
        sleepFn,
        // The same deadline bounds the spawn AND its retry sleeps: an uncapped Retry-After near
        // the budget's edge must not sleep the run past its own deadline. [LAW:single-enforcer]
        // the clamp lives in retryTransientSpawn; this seam only threads the value.
        deadline,
        now,
        onRetry: ({ attempt, limit, delay, err }) =>
          log(`${label}: transient error (attempt ${attempt}/${limit}), retrying in ${Math.round(delay / 1000)}s: ${err.message}`),
      },
    );

  // Layer 1 — the scout: a survey-only spawn. Its product is the typed scope records it logged through
  // the add_scope collector tool (validated at the collector boundary), plus a structural summary that
  // becomes shared worker context. Its findings, if any, are ignored by design. [LAW:no-silent-failure]
  // a scout that planned zero scopes fails loud here rather than running zero workers and "succeeding"
  // having reviewed nothing.
  const scoutResult = await spawn(material.buildScoutPrompt, 'scout');
  if (scoutResult.scopes.length === 0) {
    throw new Error(`Scout planned no scopes (no add_scope calls). Scout summary:\n${scoutResult.summary}`);
  }
  log(`scout planned ${scoutResult.scopes.length} scope(s): ${scoutResult.scopes.map(s => s.name).join(', ')}`);

  // [LAW:verifiable-goals] Mechanically verify the plan covers every changed file (PR only — repo
  // material carries changedPaths = [], so this is a no-op). Unmentioned paths are swept into ONE
  // synthetic catch-all scope so some worker reads them in full. The zero-scope throw above stays
  // FIRST, so a scout that planned nothing fails loud rather than being papered over by the sweep.
  const { scopes, sweptPaths, duplicatePaths, withheldAssignments } = planScopes(scoutResult.scopes, material.changedPaths, material.withheldPaths);
  if (sweptPaths.length > 0) {
    log(`⚠️ scout left ${sweptPaths.length} changed file(s) unassigned; swept into an 'unassigned files' scope: ${sweptPaths.join(', ')}`);
  }
  if (duplicatePaths.length > 0) {
    log(`⚠️ scout assigned ${duplicatePaths.length} changed file(s) to more than one scope; each is read by every claiming worker: ${duplicatePaths.join(', ')}`);
  }
  // The strip is announced, so a scout that keeps scoping withheld paths is visible as a prompt problem
  // rather than absorbed as a silent correction. Rendered through the shared bounded list for the same
  // reason the prompts and the operator log are. [LAW:no-silent-failure]
  if (withheldAssignments.length > 0) {
    log(`⚠️ scout assigned ${withheldAssignments.length} EXCLUDE_PATTERNS-withheld file(s) to a scope; removed so no worker is told to read them: ${excludedPathList(withheldAssignments)}`);
  }
  const context = scoutResult.summary.trim();

  // Layer 2 — the convergence loop (zai-recall-upr.2): the worker layer (one worker per scope, judging
  // in parallel under the concurrency cap) runs 1 + up-to-sweepCap times over the SAME scopes. Pass 0
  // is the review of record; each further pass is a convergence sweep shown the cumulative deduped
  // findings and hunting only for what is not yet on that list. [LAW:one-type-per-behavior] a sweep is
  // not a second kind of pass — it is the identical worker layer with a non-empty priorFindings value,
  // so pass 0's prompt is byte-identical to the pre-sweep engine.
  //
  // [LAW:one-source-of-truth] "Added nothing new" is decided by the SAME key that merges findings —
  // dedupeFindings — never a second sameness definition: a pass converges the round exactly when
  // merging its findings leaves the deduped cumulative set unchanged. A verbatim re-record therefore
  // never counts as new; a paraphrase of a known issue can (the dedupe key's documented noise
  // direction), which is why the loop is BOUNDED by sweepCap rather than trusting convergence alone.
  // The predicate is uniform across passes: a pass-0 with zero findings converges immediately (a clean
  // change), since a sweep after it would re-run a byte-identical prompt — a re-roll, not a hunt.
  const initialResults = [];
  const allResults = [];
  const sweeps = [];
  const unreviewedScopes = [];
  // Span-only usage records from deadline-killed spawns (null when nothing spawned) — folded into
  // the pass total below so the envelope covers time a killed scope burned. [LAW:one-source-of-truth]
  const unreviewedUsages = [];
  let budgetExhausted = false;
  let findings = [];
  for (let pass = 0; pass <= sweepCap; pass++) {
    // The sweep gate: a further pass only starts inside the budget. Pass 0 is never gated here —
    // its coverage is what the run exists to deliver, and its own workers degrade scope-by-scope
    // through the pool below. [LAW:no-silent-failure] a gate trip is announced, never a quiet
    // shortfall that reads as convergence.
    if (pass > 0 && remainingMs(deadline, now()) <= 0) {
      budgetExhausted = true;
      log(`convergence sweeps stopped before sweep ${pass} — time budget exhausted`);
      break;
    }
    const labelPrefix = pass === 0 ? '' : `sweep ${pass} `;
    const priorFindings = findings;
    const outcomes = await runScopeWorkers({
      scopes,
      maxConcurrent,
      shouldStart: () => remainingMs(deadline, now()) > 0,
      runOne: (scope) => runScopeWorker({ scope, context, material, spawn, log, priorFindings, labelPrefix }),
    });
    const results = outcomes.filter(o => o.status === 'reviewed').map(o => o.result);
    const skipped = scopes.filter((s, i) => outcomes[i].status === 'unreviewed');
    unreviewedUsages.push(...outcomes.filter(o => o.status === 'unreviewed').map(o => o.usage));
    for (const s of skipped) log(`${labelPrefix}scope '${s.name}' not reviewed — time budget exhausted`);
    if (skipped.length > 0) budgetExhausted = true;
    if (pass === 0) {
      // An unreviewed scope at pass 0 is a COVERAGE gap, carried as data to the summary and the
      // verdict; at a sweep it merely curtails convergence — pass 0's judgments of record stand.
      unreviewedScopes.push(...skipped.map(s => s.name));
      // [LAW:no-silent-failure] The budget expired before ANY scope completed: there is no review
      // to deliver, and "delivering" an empty one would approve a change nobody looked at. Fail
      // fast with the knob named — the diagnosable error the empty-handed workflow cancel never was.
      if (results.length === 0) {
        throw new DeadlineExceededError(
          `The review's time budget expired before any scope completed — no review to deliver. ${BUDGET_REMEDY}`,
        );
      }
      initialResults.push(...results);
    }
    allResults.push(...results);
    const merged = dedupeFindings([...findings, ...results.flatMap(r => r.findings)]);
    const added = merged.length - findings.length;
    findings = merged;
    if (pass > 0) {
      const curtailed = skipped.length > 0;
      sweeps.push({ added, curtailed });
      log(`convergence sweep ${pass}: ${added} new finding(s)${curtailed ? ' — cut short (time budget)' : added === 0 ? ' — converged' : pass === sweepCap ? ' — sweep cap reached' : ''}`);
    }
    if (added === 0) break;
  }

  return {
    summary: composeSummary(scopes, initialResults, sweeps, { exhausted: budgetExhausted, unreviewedScopes }),
    findings,
    // [LAW:dataflow-not-control-flow] Dependency assessments aggregate exactly like findings — a flatMap
    // over the workers plus one dedup — and with the SAME shape: no `|| []` fallback, because every worker
    // result carries an `assessments` array (readCollectedReview always returns one), exactly as it carries
    // `findings`. [LAW:one-type-per-behavior] guarding only this record kind would let an out-of-contract
    // adapter that omits the field degrade the whole section to "unassessed" silently; the bare access makes
    // that surface as a loud crash instead. [LAW:no-silent-failure] Only the go.mod-owning worker records
    // any; dedupeAssessments (keyed by module) collapses the multi-go.mod case — and the sweep-pass
    // re-assessments, which collapse by the same module key. Non-dependency PR → [].
    assessments: dedupeAssessments(allResults.flatMap(r => r.assessments)),
    // The unreviewed usages make the recorded envelope honest: a scope the deadline killed mid-spawn
    // burned real wall clock, and its span widens the pass window exactly as a reviewed spawn's does.
    usage: sumUsage([scoutResult.usage, ...allResults.map(r => r.usage), ...unreviewedUsages]),
    // [LAW:one-source-of-truth] The coverage gap as DATA, for the sinks: the PR sink withholds
    // approval when unreviewedScopes is non-empty (transport.submitReview), and run.js warns when
    // the budget bit at all. The summary text above derives from these same values, never the
    // other way around. Both are their defaults ([]/false) on every run the budget didn't touch.
    unreviewedScopes,
    budgetExhausted,
  };
}

// The engine seam both modes call. Wraps the multi-scope pass in failover.produceReview so the whole
// pass retries/advances per config. produceReview supplies (config, buildPromptFor, anchors); the
// multi-scope pass builds its own prompts per spawn from `material`, so the latter two are unused
// here — passed null, exactly as repo mode already passes null anchors. [LAW:composability]
// log is the injected progress effect (core.info in the action, a stderr writer in the dev script).
// [LAW:single-enforcer] The effort profile is the ONE source of the review's scope concurrency AND the
// reasoning raise, and this is the ONE seam where the chain and the profile meet — so both projections
// happen here: scopeConcurrency onto the worker pool's plain number, and reasoningTier folded onto each
// config's own reasoning as a FLOOR (maxTier). Folding into the chain — rather than threading the tier
// down to each adapter — means the effective config flows through produceReview unchanged, so the
// engine clamps it per its range (resolveReasoningTier) and `configUsed` (hence the attribution footer)
// automatically reports the raised tier. [LAW:dataflow-not-control-flow] a null proposed tier folds to
// each config's own reasoning (byte-identical), so an omitted/default `effort` leaves the chain untouched.
function runMultiScope({ chain, material, registry, instructionsPath, effort = defaultEffortProfile(), log = () => {}, sleepFn = sleep, deadline = null, now = Date.now }) {
  const maxConcurrent = effort.scopeConcurrency;
  const sweepCap = effort.sweepCap;
  const effectiveChain = chain.map(config => ({
    ...config,
    reasoning: maxTier(config.reasoning ?? null, effort.reasoningTier ?? null),
  }));
  const produceOnce = (config) => runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, sweepCap, log, sleepFn, deadline, now });
  // [LAW:no-ambient-temporal-coupling] ONE sleepFn and ONE clock own the whole pass's retry timing:
  // both are forwarded to produceReview, so the pass-level gates, the spawn-level retry clamp, and
  // config-level failover all measure the budget on the same injected `now` — a fake clock in a test
  // can never leave failover spending wall time the rest of the pass isn't. Defaults keep
  // production unchanged.
  // [LAW:single-enforcer] The wall-clock budget also bounds failover's retry horizon: produceReview
  // already clamps every backoff sleep to its budget, so handing it the time remaining makes retry
  // timing deadline-respecting with no second clamp — a Retry-After longer than the budget can no
  // longer sleep the run past its own deadline. min() with the default keeps the no-deadline path
  // byte-identical (remainingMs is Infinity there).
  const budgetMs = Math.min(TRANSIENT_RETRY_BUDGET_MS, remainingMs(deadline, now()));
  return produceReview(effectiveChain, null, null, produceOnce, sleepFn, budgetMs, now);
}

// [LAW:decomposition] The two MATERIALS, built once each. A material knows how to build the scout
// prompt and a worker prompt from the inputs its mode already has; the engine above is material-blind.

// PR material: the scout is handed the changed file paths; each worker sees the WHOLE annotated diff
// (so every anchor stays valid) with its scope as the CONCENTRATE focus, but reads only its scope's
// assigned files in full. files/maxDiffChars are the same values run.js uses to build the anchors, so
// worker findings and anchors share one diff.
// dependencySummaries is the (possibly empty) structured upstream-change context src/dependency-diff.js
// fetched for any go.mod bump in this PR — the ONE source both the worker prompt (this material) and the
// posted-review section (run.js) render from. [LAW:one-source-of-truth] The material derives the prompt
// NOTE from it here (renderDependencyDiffNote) and threads the RESOLVED bumps to the worker so the assess
// directive can name the exact modules. [] is the common case (no bump, or the feature is off): the note
// is '' and the bump list empty, flowing through unchanged. [LAW:dataflow-not-control-flow]
// priorPushbacks is the (possibly empty) set of this PR's earlier findings the author replied to
// (fetchPriorPushbacks, src/transport.js). Every worker receives all of them — like the whole diff, which
// each worker also sees — so a rebuttal about any file informs whichever worker owns it, and the scout
// need not partition them. [] (a first round, or no replies) flows through unchanged. [LAW:dataflow-not-control-flow]
// excluded is filterFiles' record of what EXCLUDE_PATTERNS took OUT of `files` ({patterns, paths}) — the
// one fact neither the scout nor a worker can recover from the material it is handed, since both are
// handed only what survived the filter. It reaches BOTH prompts because both reason about completeness:
// the scout plans coverage of the changed set, a worker judges it. NO_EXCLUSIONS (an unfiltered run,
// e.g. scripts/local-review.js) renders nothing in either. [LAW:dataflow-not-control-flow]
function buildPrMaterial({ files, maxDiffChars, reviewedRepoRoot, dependencySummaries = [], priorPushbacks = [], excluded = NO_EXCLUSIONS }) {
  const changedPaths = files.map(f => f.filename);
  const dependencyDiffNote = renderDependencyDiffNote(dependencySummaries);
  // Only a resolved bump has upstream context to judge; an unresolved one renders as a plain line in the
  // sink and carries no model assessment, so it is excluded from the assess directive. [LAW:no-silent-failure]
  const dependencyBumps = dependencySummaries.filter(s => s.resolved);
  return {
    // [LAW:types-are-the-program] The changed-file list is a first-class field of the material, not
    // recovered from the prompt: runMultiScopePass verifies the scout's plan covers it (planScopes).
    changedPaths,
    // [LAW:types-are-the-program] The out-of-bounds set, carried as its own field rather than inferred
    // from changedPaths' complement — see planScopes for why the complement is a different fact. The
    // scout is TOLD these paths (so it can avoid them) and the plan boundary ENFORCES it; this field is
    // what makes the second possible without the material re-deriving what filterFiles already decided.
    withheldPaths: excluded.paths,
    buildScoutPrompt: (toolNames) => buildPrScoutInput({ changedPaths, toolNames, reviewedRepoRoot, excluded }).prompt,
    // priorFindings is the convergence-sweep value threaded per pass by runScopeWorker: [] on the
    // initial pass (byte-identical prompt), the cumulative found list on a sweep. [LAW:dataflow-not-control-flow]
    buildWorkerPrompt: (focusText, toolNames, scopeFiles, priorFindings) => buildReviewInput({ files, maxDiffChars, toolNames, reviewedRepoRoot, focus: focusText, scopeFiles, dependencyDiffNote, dependencyBumps, priorPushbacks, priorFindings, excluded }).prompt,
  };
}

// Repo material: no diff. The scout surveys the tree; each worker reviews one scope, where the scope
// focus IS the repo-review `scope` value — so a worker is exactly a focused whole-repo review.
function buildRepoMaterial({ scope, excludePatterns, reviewedRepoRoot }) {
  return {
    // Repo mode has no changed-file list to verify against, so coverage-sweeping is a no-op by
    // construction: an empty value flows to planScopes, never a mode. [LAW:dataflow-not-control-flow]
    changedPaths: [],
    // Repo mode has no diff, so nothing was withheld FROM one: its exclusion patterns are a bound on
    // exploration the scout prompt already carries, not a set of named paths hidden from a file list.
    // Empty for the same reason changedPaths is — an empty value, never a mode. [LAW:dataflow-not-control-flow]
    withheldPaths: [],
    buildScoutPrompt: (toolNames) => buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
    // Repo mode has no diff to partition, so a repo worker reviews its scope broadly by exploring the
    // tree; the scopeFiles arg the PR worker uses is deliberately ignored here, while the convergence
    // sweep's priorFindings flows through exactly as in PR material. [LAW:dataflow-not-control-flow]
    buildWorkerPrompt: (focusText, toolNames, _scopeFiles, priorFindings) => buildRepoReviewInput({ scope: focusText, excludePatterns, toolNames, reviewedRepoRoot, priorFindings }).prompt,
  };
}

module.exports = {
  workerFocusText,
  sumUsage,
  composeSummary,
  planScopes,
  runScopeWorkers,
  runMultiScopePass,
  runMultiScope,
  buildPrMaterial,
  buildRepoMaterial,
};
