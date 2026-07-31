'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReviewCollector, readCollectedReview } = require('../collector');
const { runEngine } = require('./run');

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
// absolute path (no per-engine read grant needed). [LAW:effects-at-boundaries]
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
    async produceReview({ config, buildPromptFor, instructionsPath }) {
      const prompt = buildPromptFor(spec.toolNames);
      const collector = createReviewCollector();
      try {
        // The isolated scratch working directory (see the factory header). Empty and outside the
        // reviewed repo tree, so no repo-committed project-instruction file is auto-loaded.
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zai-reviewer-cwd-'));
        try {
          const home = spec.materializeHome({ config, instructionsPath, collector });
          try {
            const output = await runEngine(spec, config, prompt, home, collector, cwd);
            const usage = spec.extractUsage(output, config);
            const review = readCollectedReview(collector.recordsPath);
            // [LAW:dataflow-not-control-flow] scopes (a scout run), findings (a worker run), and
            // dependency assessments (a worker that reviewed a go.mod bump) are all carried through as
            // values; the caller uses whichever its pass produced, an empty list otherwise.
            return { summary: review.summary, findings: review.findings, scopes: review.scopes, assessments: review.assessments, usage };
          } finally {
            fs.rmSync(home, { recursive: true });
          }
        } finally {
          fs.rmSync(cwd, { recursive: true });
        }
      } finally {
        fs.rmSync(collector.dir, { recursive: true });
      }
    },
  };
}

module.exports = { makeCliAdapter };
