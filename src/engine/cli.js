'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('@actions/core');
const { createReviewCollector, readCollectedReview } = require('../collector');
const { runEngine } = require('./run');

// [LAW:no-silent-failure] Scratch-dir cleanup must never OUTRANK the review: these are throwaway
// dirs under the runner's ephemeral tmp, and a removal failure is a few leaked megabytes on a VM
// that evaporates at job end — worth a loud warning, never worth destroying the operative result.
// A throw from a finally REPLACES the in-flight value or error, which is exactly how a deadline
// kill's ENOTEMPTY (a just-killed engine's last write racing the recursive rm) once turned a
// deliverable partial review into a red run with every finding discarded. The failure still
// surfaces — as a warning naming the path — matching debug.js's stance that plumbing must not
// break the review it serves.
function removeQuietly(dir, label) {
  try {
    fs.rmSync(dir, { recursive: true });
  } catch (e) {
    core.warning(`Could not remove the engine's ${label} (${dir}) — left for the runner to reap: ${e.message}`);
  }
}

// [LAW:one-type-per-behavior] claude-code and codex are ONE behavior — a CLI agent spawned as a
// subprocess that returns findings out-of-band through the MCP collector. They differ only in
// their spawn primitives (the spec: materializeHome/buildCommand/assertSucceeded/extractUsage/...),
// never in the lifecycle that drives them. This factory holds that single produceReview
// implementation; each engine module supplies its spec.
//
// [FRAMING:parts-and-seams] The adapter contract is lifted to the judgment-vs-transport seam:
// produceReview({config, buildPromptFor, instructionsPath}) -> {summary, findings, scopes, assessments, usage}.
// The three record-kind fields are ALWAYS present arrays (empty when the spawn produced none), mirroring
// readCollectedReview's shape — a scout run fills `scopes`, a worker run fills `findings` and (for the
// go.mod-owning worker) `assessments`. This is a REQUIRED part of the contract, not optional: the
// multi-scope aggregator accesses `r.findings`/`r.assessments` with no fallback, so an adapter that omits a
// field fails loud rather than silently degrading (e.g. every bump rendering "unassessed"). A new engine —
// including a direct-API one that never touches this factory — must return all five. [LAW:composability]
// The whole MCP-collector dance (createReviewCollector -> materializeHome -> spawn -> readCollectedReview)
// is a PRIVATE detail in here — the registry/run.js contract is produceReview, never the subprocess
// mechanics. [LAW:carrying-cost]
//
// [LAW:single-enforcer] Instruction-injection guard: the engine spawns with its working directory
// set to a fresh ISOLATED temp dir that is NOT an ancestor of the reviewed repo. Every engine
// discovers project instructions (CLAUDE.md/AGENTS.md/opencode.json) from its cwd — by walking
// UPWARD, and (claude-code) by loading nested CLAUDE.md from subtrees UNDER cwd when it reads files
// there. A scratch cwd outside the repo tree defeats BOTH paths: nothing is found upward, and the
// repo — read only by absolute path, never under cwd — never triggers nested-memory loading. This
// is why the cwd must NOT be the repo's parent (that would put the repo under cwd and re-open the
// nested-memory vector for claude-code). The reviewer's own instructions load from the isolated home
// (HOME/CODEX_HOME/XDG), keyed to env not cwd, so they are untouched. The repo stays readable by
// absolute path — though a CLI's OWN directory-scoping rules may still demand a per-engine read
// grant for paths outside cwd (opencode gates them as `external_directory`; its adapter allows it),
// so verify the read path when writing a new adapter. [LAW:effects-at-boundaries]
function makeCliAdapter(spec) {
  return {
    // [LAW:single-enforcer] The shared adapter interface: exactly what registry/run.js depend on.
    // The spawn primitives in `spec` are deliberately NOT re-exposed here — they are CLI-internal.
    name: spec.name,
    toolNames: spec.toolNames,
    capabilities: spec.capabilities,

    // buildPromptFor(toolNames) is applied with THIS engine's tool identifiers, so a failover chain
    // gives each engine its own MCP tool names in the prompt. [LAW:types-are-the-program]
    // [LAW:dataflow-not-control-flow] usage is a value extracted from the engine's own output and
    // returned alongside the findings — never recomputed downstream at the cost footer.
    // [LAW:no-ambient-temporal-coupling] Nested try/finally owns cleanup ordering (LIFO): cwd and
    // home are created inside the collector's scope and torn down before it, each by its own finally,
    // so cleanup runs even when the engine throws. [LAW:no-silent-failure]
    // `deadline` (epoch ms, null = no budget) flows through untouched to runEngine, the one place
    // it bounds the spawn's lifetime — the adapter neither reads the clock nor re-decides policy.
    async produceReview({ config, buildPromptFor, instructionsPath, deadline = null }) {
      const prompt = buildPromptFor(spec.toolNames);
      const collector = createReviewCollector();
      try {
        // The isolated scratch working directory (see the factory header). Empty and outside the
        // reviewed repo tree, so no repo-committed project-instruction file is auto-loaded.
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-cwd-'));
        try {
          const home = spec.materializeHome({ config, instructionsPath, collector });
          try {
            // [LAW:one-source-of-truth] The spawn's span is stamped by runEngine — the one place
            // that owns the child's lifetime, on every termination path — and the priced instant is
            // DERIVED from span.from rather than read from a second clock. Two `new Date()` reads
            // would be free to disagree about which side of a rate boundary a spawn fell on — a
            // review whose recorded span says off-peak and whose figure says peak, with nothing to
            // say which one lied. Time is a pricing input (DeepSeek's peak/off-peak windows), so
            // this spawn is priced at the tier it actually ran in; extractUsage stays a pure
            // function of the engine's output and the instant it was given. [LAW:effects-at-boundaries]
            const { stdout: output, span } = await runEngine(spec, config, prompt, home, collector, cwd, deadline);
            // [LAW:no-silent-failure] From here the spawn HAS run and its span is known, so any
            // failure past this point — a throwing extractUsage, a ProtocolError from an engine
            // that never called finish_review — still burned real wall clock and provider cost.
            // The throw carries the span out, matching the invariant runEngine's own rejections
            // already hold: no outcome of a spawn that ran loses its duration (zai-timing-31d.4).
            try {
              const raw = spec.extractUsage(output, config, new Date(span.from));
              // The spawn's usage record: tokens and cost are the ENGINE's report and go absent
              // together when it reported nothing; span is the HOST's clock and is always present —
              // a duration cannot go missing the way a provider's token count can (zai-timing-31d.4).
              // [LAW:one-type-per-behavior] One record answers "what did this spawn consume", in
              // tokens, dollars, and seconds.
              const usage = { ...(raw ?? {}), span };
              const review = readCollectedReview(collector.recordsPath);
              // [LAW:dataflow-not-control-flow] scopes (a scout run), findings (a worker run), and
              // dependency assessments (a worker that reviewed a go.mod bump) are all carried through as
              // values; the caller uses whichever its pass produced, an empty list otherwise.
              return { summary: review.summary, findings: review.findings, scopes: review.scopes, assessments: review.assessments, usage };
            } catch (err) {
              err.span = span;
              throw err;
            }
          } finally {
            removeQuietly(home, 'temp HOME');
          }
        } finally {
          removeQuietly(cwd, 'scratch cwd');
        }
      } finally {
        removeQuietly(collector.dir, 'collector dir');
      }
    },
  };
}

module.exports = { makeCliAdapter, removeQuietly };
