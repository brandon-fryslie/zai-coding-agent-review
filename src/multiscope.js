'use strict';
const { produceReview, retryTransientSpawn, sleep } = require('./failover');
const { defaultEffortProfile, maxTier } = require('./effort');
const { dedupeFindings, dedupeAssessments } = require('./review');
const { renderDependencyDiffNote } = require('./dependency-diff');
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
// review spawn each), then the workers' findings + usage AGGREGATE into a single review value. PR and
// repo differ only in two values they already differ on elsewhere — the `material` (what the scout
// surveys and what each worker reviews) and the `sink` (how findings leave). [LAW:one-type-per-behavior]
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
// in partitionFindings share one key and one severity-merge rule. [LAW:single-enforcer]

// [LAW:effects-at-boundaries] Pure: sum the per-spawn Usage values into one. Token counts always add.
// Cost is uniform by construction — every spawn in a pass runs on ONE config, so all costs share the
// same model and the same availability — so the sum is available iff every spawn's cost is, carrying
// the same unavailable reason otherwise. [LAW:no-silent-failure] no spawn's cost is silently dropped.
// usage === null (an engine reported nothing) is excluded; all-null sums to null, matching the
// single-spawn behavior the cost renderer already handles.
function sumUsage(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;
  const inputTokens = present.reduce((sum, u) => sum + u.inputTokens, 0);
  const outputTokens = present.reduce((sum, u) => sum + u.outputTokens, 0);
  const cost = present.every(u => u.cost.available)
    ? { available: true, usd: present.reduce((sum, u) => sum + u.cost.usd, 0) }
    : { available: false, reason: present.find(u => !u.cost.available).cost.reason };
  return { inputTokens, outputTokens, cost };
}

// [LAW:effects-at-boundaries] Pure: the aggregated review summary. It names every scope reviewed and
// carries each worker's own summary verbatim — never the scout's raw JSON, which stays out of the
// author-facing text. [LAW:one-source-of-truth]
function composeSummary(scopes, workerResults) {
  const lines = [`Reviewed ${scopes.length} scope(s): ${scopes.map(s => s.name).join(', ')}.`, ''];
  for (const r of workerResults) {
    lines.push(`**${r.name}** — ${(r.summary || '(no summary)').trim()}`);
  }
  return lines.join('\n');
}

// [LAW:dataflow-not-control-flow] A bounded-concurrency worker pool that is FAIL-LOUD: the first error
// stops new work and is rethrown after in-flight workers settle, preserving its type (a TransientError
// stays a TransientError so failover can classify it). [LAW:no-silent-failure] this is the deliberate
// inverse of swallowing a failed scope into an empty-finding result — an unreviewed scope must never
// pass as a clean one. results are returned in scope order.
async function runScopeWorkers({ scopes, runOne, maxConcurrent }) {
  const results = new Array(scopes.length);
  let next = 0;
  let firstError = null;
  async function lane() {
    while (next < scopes.length && !firstError) {
      const i = next++;
      try {
        results[i] = await runOne(scopes[i]);
      } catch (e) {
        firstError = firstError || e;
      }
    }
  }
  const laneCount = Math.min(Math.max(1, maxConcurrent), scopes.length);
  await Promise.all(Array.from({ length: laneCount }, lane));
  if (firstError) throw firstError;
  return results;
}

// One scope worker: a single review spawn on this config, focused on one scope. [LAW:composability]
// It does one thing — review one scope — and returns its raw findings + summary + usage as a value.
// `spawn` is the transient-retry-wrapped engine spawn (see runMultiScopePass), so a blip retries THIS
// worker in place rather than failing the whole pass. [LAW:decomposition]
async function runScopeWorker({ scope, context, material, spawn, log }) {
  const focusText = workerFocusText(scope, context);
  // [LAW:decomposition] The worker reads its scope's assigned files in full, not the whole changed set;
  // the material threads scope.files into the read instruction. Repo material ignores it (no diff).
  const buildPromptFor = (toolNames) => material.buildWorkerPrompt(focusText, toolNames, scope.files);
  log(`scope '${scope.name}' starting…`);
  // [LAW:dataflow-not-control-flow] Every record kind the spawn produced flows through this seam
  // unbroken — findings AND dependency assessments (the go.mod-owning worker's per-module judgments).
  // Dropping assessments here would silently strip the whole feature: the aggregation's `|| []` fallback
  // would fire on every worker and every bump would render "unassessed". [LAW:no-silent-failure]
  const { summary, findings, assessments, usage } = await spawn(buildPromptFor, `scope '${scope.name}'`);
  log(`scope '${scope.name}' done — ${findings.length} finding(s)`);
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
function planScopes(scopes, changedPaths) {
  const assigned = new Set(scopes.flatMap(s => s.files));
  const sweptPaths = changedPaths.filter(p => !assigned.has(p));
  // [LAW:verifiable-goals] The scout promises each changed file appears in EXACTLY one scope. The sweep
  // catches the lower bound (a file in no scope); this catches the upper bound (a file in two+ scopes),
  // where two workers each read it in full — the redundant cost the whole change exists to remove. It is
  // surfaced as an observable value, not silently folded away by the Set above. [LAW:no-silent-failure]
  const seen = new Set();
  const recordedDup = new Set();
  const duplicatePaths = [];
  for (const p of scopes.flatMap(s => s.files)) {
    if (seen.has(p) && !recordedDup.has(p)) {
      recordedDup.add(p);
      duplicatePaths.push(p); // first-seen order, each duplicate once — O(1) membership, O(n) overall
    }
    seen.add(p);
  }
  if (sweptPaths.length === 0) return { scopes, sweptPaths, duplicatePaths };
  const catchAll = {
    name: 'unassigned files',
    focus: `These changed files were not covered by the planned scopes: ${sweptPaths.join(', ')}. Review their changes fully.`,
    files: sweptPaths,
  };
  return { scopes: [...scopes, catchAll], sweptPaths, duplicatePaths };
}

// One full multi-scope pass for ONE config: scout → workers → aggregate. This is the produceOnce that
// failover.produceReview drives, so the whole pass is one attempt and retry/failover wraps it as a
// unit. Returns the same {summary, findings, usage} shape a single engine spawn used to return, so
// every downstream sink stays unchanged. [LAW:decomposition]
async function runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log, sleepFn = sleep }) {
  const adapter = registry.get(config.engine);

  // [LAW:decomposition] Every engine spawn in this pass goes through one transient-retry seam, so a
  // single flaky request (a dropped socket, a 5xx) is absorbed in place — the scout and each worker
  // recover independently and a blip never re-runs the whole pass. An exhausted or non-transient error
  // still propagates, so config-level failover (produceReview) is unchanged. [LAW:one-source-of-truth]
  const spawn = (buildPromptFor, label) =>
    retryTransientSpawn(
      () => adapter.produceReview({ config, buildPromptFor, instructionsPath }),
      {
        sleepFn,
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
  const { scopes, sweptPaths, duplicatePaths } = planScopes(scoutResult.scopes, material.changedPaths);
  if (sweptPaths.length > 0) {
    log(`⚠️ scout left ${sweptPaths.length} changed file(s) unassigned; swept into an 'unassigned files' scope: ${sweptPaths.join(', ')}`);
  }
  if (duplicatePaths.length > 0) {
    log(`⚠️ scout assigned ${duplicatePaths.length} changed file(s) to more than one scope; each is read by every claiming worker: ${duplicatePaths.join(', ')}`);
  }
  const context = scoutResult.summary.trim();

  // Layer 2 — one worker per scope, judging in parallel under the concurrency cap.
  const workerResults = await runScopeWorkers({
    scopes,
    maxConcurrent,
    runOne: (scope) => runScopeWorker({ scope, context, material, spawn, log }),
  });

  return {
    summary: composeSummary(scopes, workerResults),
    findings: dedupeFindings(workerResults.flatMap(r => r.findings)),
    // [LAW:dataflow-not-control-flow] Dependency assessments aggregate exactly like findings — a flatMap
    // over the workers plus one dedup — and with the SAME shape: no `|| []` fallback, because every worker
    // result carries an `assessments` array (readCollectedReview always returns one), exactly as it carries
    // `findings`. [LAW:one-type-per-behavior] guarding only this record kind would let an out-of-contract
    // adapter that omits the field degrade the whole section to "unassessed" silently; the bare access makes
    // that surface as a loud crash instead. [LAW:no-silent-failure] Only the go.mod-owning worker records
    // any; dedupeAssessments (keyed by module) collapses the multi-go.mod case. Non-dependency PR → [].
    assessments: dedupeAssessments(workerResults.flatMap(r => r.assessments)),
    usage: sumUsage([scoutResult.usage, ...workerResults.map(r => r.usage)]),
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
function runMultiScope({ chain, material, registry, instructionsPath, effort = defaultEffortProfile(), log = () => {}, sleepFn = sleep }) {
  const maxConcurrent = effort.scopeConcurrency;
  const effectiveChain = chain.map(config => ({
    ...config,
    reasoning: maxTier(config.reasoning ?? null, effort.reasoningTier ?? null),
  }));
  const produceOnce = (config) => runMultiScopePass({ config, material, registry, instructionsPath, maxConcurrent, log, sleepFn });
  // [LAW:no-ambient-temporal-coupling] Forward the injected clock to produceReview too, so ONE sleepFn
  // owns the whole pass's retry timing — spawn-level (inside the pass) AND config-level failover here.
  // Defaults to the real sleep, so production is unchanged; a test injects a stub to drive failover fast.
  return produceReview(effectiveChain, null, null, produceOnce, sleepFn);
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
function buildPrMaterial({ files, maxDiffChars, reviewedRepoRoot, dependencySummaries = [] }) {
  const changedPaths = files.map(f => f.filename);
  const dependencyDiffNote = renderDependencyDiffNote(dependencySummaries);
  // Only a resolved bump has upstream context to judge; an unresolved one renders as a plain line in the
  // sink and carries no model assessment, so it is excluded from the assess directive. [LAW:no-silent-failure]
  const dependencyBumps = dependencySummaries.filter(s => s.resolved);
  return {
    // [LAW:types-are-the-program] The changed-file list is a first-class field of the material, not
    // recovered from the prompt: runMultiScopePass verifies the scout's plan covers it (planScopes).
    changedPaths,
    buildScoutPrompt: (toolNames) => buildPrScoutInput({ changedPaths, toolNames, reviewedRepoRoot }).prompt,
    buildWorkerPrompt: (focusText, toolNames, scopeFiles) => buildReviewInput({ files, maxDiffChars, toolNames, reviewedRepoRoot, focus: focusText, scopeFiles, dependencyDiffNote, dependencyBumps }).prompt,
  };
}

// Repo material: no diff. The scout surveys the tree; each worker reviews one scope, where the scope
// focus IS the repo-review `scope` value — so a worker is exactly a focused whole-repo review.
function buildRepoMaterial({ scope, excludePatterns, reviewedRepoRoot }) {
  return {
    // Repo mode has no changed-file list to verify against, so coverage-sweeping is a no-op by
    // construction: an empty value flows to planScopes, never a mode. [LAW:dataflow-not-control-flow]
    changedPaths: [],
    buildScoutPrompt: (toolNames) => buildRepoScoutInput({ scope, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
    // Repo mode has no diff to partition, so a repo worker reviews its scope broadly by exploring the
    // tree; the scopeFiles arg the PR worker uses is deliberately ignored here. [LAW:dataflow-not-control-flow]
    buildWorkerPrompt: (focusText, toolNames) => buildRepoReviewInput({ scope: focusText, excludePatterns, toolNames, reviewedRepoRoot }).prompt,
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
