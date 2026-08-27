'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const { filterFiles, buildReviewAnchors, diffChurn, excludedPathList } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget, prIsFromFork, summarizePriorReviews, resolveReviewerIdentities, announceNotReviewed, releaseUnrevisitableBlocks, forkNotice, roundCapNotice, fetchPriorPushbacks, roundCapReached, parseMaxRounds, parseReviewerName } = require('./transport');
const { buildReviewInput } = require('./prompt');
const { partitionFindings } = require('./review');
const { buildAttributionFooter } = require('./failover');
const { runMultiScope, buildPrMaterial, buildRepoMaterial } = require('./multiscope');
const { defaultEffortProfile } = require('./effort');
const { parseDailyBudgetUsd, defaultBudgetCandidates, chooseProfile, effectiveRounds } = require('./budget');
const { assessDifficulty } = require('./difficulty');
const { difficultyCandidates, parseDifficultyScaling } = require('./difficulty-policy');
const { readSpentToday, appendCost } = require('./ledger');
const { parseDependencyDiffFlag, parseGoModBumps, fetchUpstreamChangeSummary, unresolvedSummary, renderDependencyReviewSection } = require('./dependency-diff');
const { renderCostLine, costWarning, costMarker, renderPrTime } = require('./usage');
const { renderTimingBreakdown } = require('./schedule');
const { renderRepoReport } = require('./report');
const registry = require('./engine/registry');
const { loadConfig, peekConfigNames } = require('./config');
const { parseTimeBudgetMinutes, mintDeadline, BUDGET_REMEDY } = require('./deadline');
const { synthesizeProviderConfig } = require('./provider');
const { selectConfig } = require('./selection');
const { preflight } = require('./preflight');
const { TRANSCRIPT_DIR } = require('./debug');

// ACTION_ROOT resolves to the repo root whether running as an action (GITHUB_ACTION_PATH
// is set) or from src/ during local development (one level above __dirname).
const ACTION_ROOT = process.env.GITHUB_ACTION_PATH || path.join(__dirname, '..');
const REVIEW_AGENT_INSTRUCTIONS_PATH = path.join(ACTION_ROOT, 'review-agent', 'instructions.md');

// [LAW:one-source-of-truth] The absolute path of the REVIEWED repo (the checked-out working tree),
// resolved once at the boundary. The engine spawns with an isolated working directory OUTSIDE this
// tree (owned by the CLI adapter), so a repo-committed CLAUDE.md/AGENTS.md can never be auto-loaded
// as reviewer instructions; the repo is reached only by this explicit path, which the prompt hands
// to the agent for absolute-path Read/Grep/Glob. GITHUB_WORKSPACE is set by GitHub Actions and
// Gitea's act_runner alike; process.cwd() is the local-dev fallback. [LAW:effects-at-boundaries]
const REVIEWED_REPO_ROOT = process.env.GITHUB_WORKSPACE || process.cwd();

// [LAW:decomposition] The review engine — scout → workers → aggregate, wrapped in failover — now
// lives in src/multiscope.js as runMultiScope, the single seam both modes call. The orchestrator
// only chooses the `material` (what the scout surveys, what each worker reviews) and the `sink`
// (how findings leave); it owns no CLI lifecycle and no retry timing. [LAW:types-are-the-program]

// [LAW:decomposition] Establish the typed ReviewConfig chain for this run and register its
// secrets. selection is the value PR/repo modes differ on: a PR run passes its labels + body so a
// config file can pick a per-PR reviewer; a repo run has no PR, so it passes empty selectors and
// per-PR rules fall through to the explicit CONFIG input or the file default. [LAW:dataflow-not-control-flow]
// Throws on any config error so the single caller boundary reports it via setFailed.
function buildConfigChain(selection) {
  // [LAW:one-source-of-truth] Default path is declared in action.yml; do not duplicate it here.
  const configFilePath = core.getInput('CONFIG_FILE');
  const configNameInput = core.getInput('CONFIG');

  if (fs.existsSync(configFilePath)) {
    const { configNames, defaultName } = peekConfigNames(configFilePath);
    const selectedName = selectConfig(selection, { configInput: configNameInput, configNames, defaultName });
    core.info(`Selected reviewer config: '${selectedName}'`);
    const chain = loadConfig(configFilePath, selectedName, process.env);
    // [LAW:one-type-per-behavior] Every auth variant names its credential the same, so masking is one
    // read that covers all of them — a variant added later is masked by construction rather than by
    // someone remembering to extend a per-variant switch. [LAW:no-silent-failure]
    chain.forEach(c => core.setSecret(c.endpoint.credential.value));
    return chain;
  }

  // [LAW:dataflow-not-control-flow] Simple mode: the PROVIDER value alone decides the engine —
  // credential presence never steers it. The chosen provider's key is then required, and its
  // absence fails loud naming the input to set. [LAW:no-silent-failure]
  const config = synthesizeProviderConfig({
    provider: core.getInput('PROVIDER'),
    openaiApiKey: core.getInput('OPENAI_API_KEY'),
    openaiModel: core.getInput('OPENAI_MODEL'),
    openaiReasoning: core.getInput('OPENAI_REASONING_EFFORT'),
    openaiBaseUrl: core.getInput('OPENAI_BASE_URL'),
    zaiApiKey: core.getInput('ZAI_API_KEY'),
    zaiModel: core.getInput('ZAI_MODEL'),
    zaiSystemPrompt: core.getInput('ZAI_SYSTEM_PROMPT'),
    zaiBaseUrl: core.getInput('ZAI_BASE_URL'),
    deepseekApiKey: core.getInput('DEEPSEEK_API_KEY'),
    deepseekModel: core.getInput('DEEPSEEK_MODEL'),
    deepseekBaseUrl: core.getInput('DEEPSEEK_BASE_URL'),
    // No CLAUDE_BASE_URL: a subscription token is only valid against Anthropic's own API, so the
    // provider row takes no base-URL input and there is nothing here to read. [LAW:types-are-the-program]
    claudeCodeOauthToken: core.getInput('CLAUDE_CODE_OAUTH_TOKEN'),
    claudeModel: core.getInput('CLAUDE_MODEL'),
  });
  core.setSecret(config.endpoint.credential.value);
  core.info(
    `Using provider '${config.name}' (engine: ${config.engine}, model: ${config.model}, ` +
    // The auth method is operator news: it is how a run log answers "did this actually bill the
    // subscription, or did it quietly fall back to a paid key?" [LAW:no-silent-failure]
    `auth: ${config.endpoint.credential.kind}).`,
  );
  return [config];
}

// [LAW:effects-at-boundaries] The preflight boundary: preflight() does the network probe and
// returns data; this renders the verdict to the Actions log and decides the gate. [LAW:no-silent-failure]
// a hard failure (bad key, unreachable endpoint) stops here with a precise cause, before the
// expensive engine spawn — a misconfigured run no longer fails cryptically deep inside the agent.
// Returns true when the chain is usable. [LAW:single-enforcer] both review modes gate through here.
async function preflightChain(chain) {
  const { ok, results } = await preflight(chain);
  for (const r of results) {
    if (r.skipped) core.info(`Preflight: config '${r.name}' — skipped (${r.hint}).`);
    else if (r.healthy) core.info(`Preflight: config '${r.name}' — OK${r.reason === 'reachable' ? ` (${r.hint})` : ''}.`);
    else core.warning(`Preflight: config '${r.name}' — ${r.reason}: ${r.hint}.`);
  }
  if (!ok) {
    const failed = results.filter(r => !r.skipped && !r.healthy);
    core.setFailed(
      'Preflight failed — no usable review provider. '
      + failed.map(r => `config '${r.name}': ${r.hint}`).join('; ')
      + '. Fix the named cause and re-run; this cheap check runs before the review to surface setup errors fast.',
    );
  }
  return ok;
}

// [LAW:effects-at-boundaries] The cost-reporting boundary, shared by both sinks: renderCostLine
// and costWarning are pure; this is the one place the "loud, not silent" signal is emitted, and it
// returns the full attribution + cost footer. [LAW:no-silent-failure] costWarning names the actual
// cause (carried in usage.cost.reason), so the boundary never re-derives why cost is absent.
// priorCost (PR mode only) is the summed cost of this PR's earlier review rounds; when present the cost
// line carries a running PR total, and a machine-readable cost marker is embedded so the NEXT round can
// sum this one. Repo mode passes no priorCost — the single-round line stands, and the (harmless) marker
// simply isn't read by anyone. [LAW:dataflow-not-control-flow]
// [LAW:types-are-the-program] The timing envelope is DESTRUCTURED at the seam, into the three facts it
// carries, because they are read in different places below — two inside the render's try, one
// outside it. Reaching into `timing` at each use made an absent envelope a THROWN review at whichever
// use happened to sit outside the try, which is precisely the trade this epic forbids: time is
// diagnostics, findings are the product. Named here, an absent envelope is an absent schedule, an
// absent total and an absent prior duration — three values the renderer already knows how to report
// as gaps, the last of them as no cumulative clause at all. [LAW:no-silent-failure]
function buildReviewFooter(usage, configUsed, priorCost, { schedule = null, totalMs, priorDuration = null } = {}) {
  const warning = costWarning(usage, configUsed);
  if (warning) core.warning(warning);
  const costLine = renderCostLine(usage, configUsed, priorCost);
  if (costLine) core.info(costLine.replace(/^_|_$/g, ''));
  // The timing breakdown renders beside the cost, from the schedule the pass recorded and the total
  // the run's clock minted (zai-timing-31d.6) — this boundary only formats; every figure derives in
  // src/schedule.js. [LAW:one-source-of-truth] Time is diagnostics and findings are the product, so
  // a render failure omits the block LOUDLY — a warning naming the cause — and never fails the
  // review. [LAW:no-silent-failure] An absent schedule is not a failure: it renders as an explicit
  // gap inside renderTimingBreakdown.
  // The PR's cumulative agent time (zai-timing-31d.3) is rendered INSIDE the try with the block it
  // joins: it reads the same prior-review markers the cost total does, and if that rendering fails
  // the whole timing block is omitted loudly rather than a review being lost to a diagnostic.
  // priorDuration is null in repo mode — no cross-run store to read — and the clause is then empty,
  // so the line reports this run alone. [LAW:no-silent-failure]
  let timingBlock = null;
  try {
    timingBlock = renderTimingBreakdown(schedule, totalMs, renderPrTime(totalMs, priorDuration));
    core.info(timingBlock.split('\n')[0].replace(/^_|_$/g, ''));
  } catch (e) {
    core.warning(`Timing breakdown unavailable (${e.message}) — the review is posted without it.`);
  }
  // The SAME total the block above rendered for humans, recorded into the marker for machines
  // (zai-timing-31d.2) — one figure, two audiences, so a PR's cumulative agent time is summed from
  // what its reviews actually reported rather than from a second measurement. [LAW:one-source-of-truth]
  // It rides the cost marker deliberately: see THE RUN'S DURATION RIDES THIS RECORD in src/usage.js.
  // Recording is outside the try above on purpose — the render is the fragile part (formatting a
  // schedule), while `totalMs` is a number the run's own clock minted, and a failed BLOCK must not
  // also cost the next round its summand.
  const marker = costMarker(usage, configUsed, totalMs);
  return [buildAttributionFooter(configUsed), costLine, timingBlock, marker].filter(Boolean).join('\n\n');
}

// [LAW:one-source-of-truth] The budget-exhaustion warning, composed ONCE for both review modes from
// the review's coverage data plus the one remedy sentence (BUDGET_REMEDY, src/deadline.js) — never
// re-authored per sink, so the operator remedy cannot drift between modes or from the error
// messages that share it. [LAW:no-silent-failure] the budget biting is operator news, not just
// review-body prose: the warning makes a curtailed review visible in the run's annotations.
function warnBudgetExhausted(review) {
  if (!review.budgetExhausted) return;
  // The same two budget states composeSummary distinguishes, distinguished here too: a coverage
  // gap names the unreviewed scopes; curtailed-only means every scope WAS reviewed and only the
  // convergence sweeps were cut short — "0 scope(s) went unreviewed" would contradict itself.
  const state = review.unreviewedScopes.length > 0
    ? `${review.unreviewedScopes.length} scope(s) went unreviewed (${review.unreviewedScopes.join(', ')})`
    : 'every scope was reviewed, but convergence sweeps were cut short';
  core.warning(`Review time budget exhausted: ${state}. The collected findings were still delivered. ${BUDGET_REMEDY}`);
}

// [LAW:decomposition] The one fetch site for the reviewed diff: select the host transport, pull the
// changed files, apply EXCLUDE_PATTERNS, and emit the "fetching"/"excluded" logs. runPrReview calls it
// exactly once — the budget phase (when active) needs the diff BEFORE the round-cap gate to size the
// review's cost, so it fetches here early and the downstream review reuses the result; when budget is
// off, this runs in its original post-preflight position, unchanged. [LAW:one-source-of-truth]
// [LAW:one-source-of-truth] `excluded` — what the filter removed — travels OUT of here as a value
// alongside the files that survived, because it is a fact about the material the review is about to
// judge and the reviewer cannot see it from the inside (buildPrMaterial confesses it in the prompt).
// The operator log reads the same record rather than recovering a count by subtracting list lengths, and
// renders it through the SAME bounded list the prompts use: a `vendor/**` or grouped-dependency PR
// withholds thousands of paths, and one unbounded line floods the Actions log while telling the operator
// no more than a bounded one does. The count is always exact — it is the list, never the number, that the
// bound touches. [LAW:one-source-of-truth]
async function fetchFilteredFiles(octokit, owner, repo, pullNumber, excludePatterns) {
  core.info(`Fetching changed files for PR #${pullNumber}...`);
  // Fetching a diff does NOT mean a review will be submitted: this also runs purely to size the change
  // for the budget/difficulty gradient, before the round-cap gate, and that push can return without
  // reviewing anything. So the refused-file warning is not announced here — submitReview owns it, being
  // the one place a review is actually submitted. [LAW:decomposition]
  const transport = await selectTransport(octokit, owner, repo, pullNumber);
  const { reviewed, excluded } = filterFiles(transport.files, excludePatterns);
  if (excluded.paths.length > 0) {
    core.info(`Excluded ${excluded.paths.length} file(s) matching EXCLUDE_PATTERNS: ${excludedPathList(excluded.paths)}`);
  }
  return { transport, filteredFiles: reviewed, excluded };
}

// [LAW:dataflow-not-control-flow] Pure. The log fragment naming a RAISED reasoning tier — a value, empty
// when nothing was raised (the null baseline needs no mention). Both effort-resolution log lines share it
// so the operator sees "thorough" reviews the same way in the budget and difficulty-only paths.
function reasoningNote(reasoningTier) {
  return reasoningTier ? `, reasoning ${reasoningTier} (raised for a complex diff)` : '';
}

// [LAW:effects-at-boundaries] The budget phase (PR mode). The pure decision is chooseProfile; the effect
// this boundary owns is the ledger read whose failure policy is spend-safe. [LAW:no-silent-failure] a
// failed read falls back SPEND-SAFE — proceed as if under budget (spentToday 0 ⇒ full remaining ⇒ full
// effort) with a loud warning, never a silent throttle on missing data; unknown ledger entries make the
// day's spend a logged LOWER bound (undercount ⇒ spend more, never a false stop). [LAW:decomposition] the
// candidate set is PROPOSED upstream (difficulty, or the default de-rate ladder) and passed in — budget
// only CAPS what it is handed, it does not decide the proposal. Every candidate is ≤ the user's ceiling,
// so the returned profile can only cap effort, never raise it. Returns the chosen EffortProfile.
async function resolveBudgetedEffort({ octokit, owner, repo, issueNumber, now, candidates, filteredFiles, dailyBudget }) {
  let spentToday = 0;
  try {
    const ledger = await readSpentToday(octokit, owner, repo, issueNumber, now);
    // [LAW:types-are-the-program] The gradient rations DOLLARS, so it reads the `billed` tally and
    // nothing else. A subscription round's marker lands it in `notional`, a tally this line never
    // reads — it cannot throttle a budget against money that was never spent. The tally shape is
    // unit-blind (see emptyTally in src/usage.js); the unit is whatever the BUCKET means, which is
    // why the bucket and not a field name is what keeps list price out of the day's spend.
    spentToday = ledger.billed.total;
    if (ledger.billed.unknownCount > 0) {
      core.warning(
        `Budget: ledger issue #${issueNumber} has ${ledger.billed.unknownCount} entr(ies) with unknown cost — `
        + `today's spend ($${spentToday.toFixed(4)}) is a LOWER bound; the gradient rations at least this cautiously.`,
      );
    }
    // [LAW:no-silent-failure] Subscription consumption is reported, not hidden: the operator sees what
    // the day's quota-billed reviews would have cost at list price, stated as the separate figure it
    // is. It is emitted here and summed into nothing.
    const notionalRounds = ledger.notional.count + ledger.notional.unknownCount;
    if (notionalRounds > 0) {
      // [LAW:no-silent-failure] The rounds counted and the dollars summed come from DIFFERENT
      // populations: every notional round is counted, but only the ones that reported a list price
      // are summed. Printing the figure bare would pass a partial total off as complete — the exact
      // accounting lie this change exists to kill — so an unreported remainder is named, the same
      // honesty the billed tally gets above. [LAW:dataflow-not-control-flow] the remainder selects a
      // string; one unconditional render consumes it.
      const unreported = ledger.notional.unknownCount > 0
        ? `, a LOWER bound — ${ledger.notional.unknownCount} of them reported no list price`
        : '';
      core.info(
        `Budget: ${notionalRounds} of today's review(s) were billed to Claude subscription quota, not `
        + `dollars — $${ledger.notional.total.toFixed(4)} at Anthropic list price${unreported}. It is `
        + "excluded from the day's dollar spend and summed into nothing.",
      );
    }
  } catch (e) {
    core.warning(
      `Budget: failed to read cost ledger issue #${issueNumber} (${e.message}) — proceeding SPEND-SAFE as if `
      + 'under budget (full effort). Verify LEDGER_ISSUE and the token\'s issues:write access (the gradient '
      + 'also appends after review, so issues:write — not just read — is the single permission the feature needs).',
    );
  }

  const diffSize = diffChurn(filteredFiles);
  const decision = chooseProfile({ candidates, spentToday, dailyBudget, diffSize });
  const capNote = decision.withinCap
    ? 'within cap'
    : 'budget FLOOR — even the cheapest candidate exceeds the cap; running the minimal review';
  core.info(
    `Budget: spent today $${spentToday.toFixed(4)} of $${dailyBudget.toFixed(2)} → per-review cap `
    + `$${decision.capUsd.toFixed(4)}; churn ${diffSize} line(s); chose roundCap ${decision.profile.roundCap}`
    + `${reasoningNote(decision.profile.reasoningTier)} `
    + `(est. $${decision.estimatedUsd.toFixed(4)}; ${capNote}).`,
  );
  return decision.profile;
}

// [LAW:effects-at-boundaries] Difficulty scaling WITHOUT the budget gradient: the difficulty-proposed
// candidate ladder with no daily spend cap. [LAW:dataflow-not-control-flow] "no budget" is the value
// Infinity, not a second selector — the SAME chooseProfile ranks the ladder, and an unbounded cap makes
// every candidate affordable, so it returns the most expensive one: exactly the difficulty-proposed
// ceiling. No ledger IO (no spend to ration) — a pure decision over the pre-spend proposal, logged.
// Returns the chosen EffortProfile.
function resolveDifficultyEffort({ candidates, filteredFiles }) {
  const diffSize = diffChurn(filteredFiles);
  const decision = chooseProfile({ candidates, spentToday: 0, dailyBudget: Infinity, diffSize });
  core.info(
    `Difficulty: churn ${diffSize} line(s) → proposed roundCap ${decision.profile.roundCap}`
    + `${reasoningNote(decision.profile.reasoningTier)} `
    + `(from ${candidates.length} candidate profile(s); no daily budget, so the difficulty proposal stands).`,
  );
  return decision.profile;
}

// [LAW:effects-at-boundaries] Pure. Attribute a round-cap de-rate to the lever(s) that ACTUALLY bound,
// given the final resolved cap, the ceiling difficulty proposed (before any budget cap), and the user's
// configured MAX_REVIEW_ROUNDS. Two levers can lower the cap and either/both can bind: difficulty bound
// iff its proposed ceiling fell below the default; budget bound iff the final cap fell below what
// difficulty proposed. [LAW:dataflow-not-control-flow] compared in effectiveRounds space so the
// 0=unlimited sentinel ranks correctly. `deRated` is exactly the union of the two bound flags — since
// effort ≤ difficultyCeiling ≤ default always, a de-rate can only come from one or both — so a de-rated
// cap always names at least one binding lever, never an empty list. [LAW:no-silent-failure]
function bindingLevers({ effortRoundCap, difficultyCeilingRoundCap, defaultRoundCap }) {
  return {
    deRated: effectiveRounds(effortRoundCap) < effectiveRounds(defaultRoundCap),
    budgetBound: effectiveRounds(effortRoundCap) < effectiveRounds(difficultyCeilingRoundCap),
    difficultyBound: effectiveRounds(difficultyCeilingRoundCap) < effectiveRounds(defaultRoundCap),
  };
}

// The per-bump caps in dependency-diff.js (MAX_COMMITS/MAX_FILES) bound one module's contribution
// to the note; this bounds how many MODULES get fetched at all — a grouped Dependabot PR can bump
// many requirements in one go.mod diff, and without this a five-module bump would still inject
// several hundred lines into every worker's prompt. [LAW:no-mode-explosion] one fixed constant.
const MAX_DEPENDENCY_BUMPS_FETCHED = 8;

// [LAW:effects-at-boundaries] The dependency-diff boundary: parses go.mod's OWN diff for version
// bumps and fetches each bumped module's upstream change via the trusted host's octokit client —
// the reviewing engine never makes this call itself (src/dependency-diff.js). Returns the STRUCTURED
// summaries (the one source both renderings derive from — the prompt note via renderDependencyDiffNote,
// the posted-review section via renderDependencyReviewSection). [LAW:one-source-of-truth] Off by default
// (dependencyDiffOn=false) is byte-identical to before this feature: no go.mod scan, no fetch, [] flows
// through unchanged. [LAW:no-silent-failure] a per-bump fetch failure (bad ref, unresolvable module,
// rate limit) is carried as `resolved: false` rather than thrown — one unreachable upstream must never
// abort the whole review. A bump beyond MAX_DEPENDENCY_BUMPS_FETCHED is the same shape: not fetched, but
// reported as such, not dropped.
async function resolveDependencySummaries(octokit, filteredFiles, dependencyDiffOn) {
  if (!dependencyDiffOn) return [];
  // A monorepo can carry more than one go.mod (nested modules, e.g. tools/go.mod) — every one of
  // them is in scope, not just the root file, so a bump in a nested module is never silently skipped.
  // A vendored go.mod (vendor/.../go.mod) is excluded: it describes the VENDORED dependency's own
  // requirements, not this project's — matching it would fetch and inject irrelevant upstream context.
  const goMods = filteredFiles.filter(f => f.patch
    && (f.filename === 'go.mod' || f.filename.endsWith('/go.mod'))
    && !f.filename.startsWith('vendor/'));
  if (goMods.length === 0) return [];
  const bumps = goMods.flatMap(f => parseGoModBumps(f.patch));
  if (bumps.length === 0) return [];
  const toFetch = bumps.slice(0, MAX_DEPENDENCY_BUMPS_FETCHED);
  // [LAW:single-enforcer] Built through unresolvedSummary like every other unresolved bump, so this is
  // not a second construction site for the same typed value. Today's reason is host-authored text with
  // only a number in it and could not carry a separator; routing it through the constructor is what
  // keeps that true when someone later interpolates the module path or an error message into it.
  const skipped = bumps.slice(MAX_DEPENDENCY_BUMPS_FETCHED).map(b =>
    unresolvedSummary(b, `upstream context not fetched — this PR bumps more than ${MAX_DEPENDENCY_BUMPS_FETCHED} modules`));
  core.info(`Dependency diff: fetching upstream context for ${toFetch.length} go.mod bump(s)`
    + `${skipped.length > 0 ? ` (${skipped.length} more skipped — over the ${MAX_DEPENDENCY_BUMPS_FETCHED}-module cap)` : ''}...`);
  const fetched = await Promise.all(toFetch.map(b => fetchUpstreamChangeSummary(octokit, b)));
  const summaries = [...fetched, ...skipped];
  for (const s of summaries) {
    core.info(s.resolved
      ? `Dependency diff: ${s.modulePath} ${s.from} → ${s.to} — ${s.totalCommits} upstream commit(s) via github.com/${s.owner}/${s.repoName}.`
      : `Dependency diff: ${s.modulePath} ${s.from} → ${s.to} — ${s.reason}.`);
  }
  return summaries;
}

// PR-diff review: fetch the PR, gate forks, build the diff material + anchors, run the engine
// chain, and submit an inline GitHub review. `deadline` (epoch ms, null = no budget) is the run's
// wall-clock budget, minted once in run(); the pre-review phases here (PR fetch, preflight,
// dependency fetch) spend from it implicitly because it is absolute.
// `startedAt` (epoch ms) is the run's start instant from that SAME mint — the timing footer's
// total is (now - startedAt), so it counts preflight, the diff fetch and host I/O, time no spawn
// owns; the engine's live per-pass running totals count from the same instant (zai-timing-31d.7).
// The entry default covers direct callers (tests, embedding): for them THIS boundary is the
// run boundary, so the mint moves here rather than a second clock appearing anywhere inland.
// [LAW:no-ambient-temporal-coupling]
async function runPrReview(reviewerName, excludePatterns, defaultEffort, deadline, startedAt = Date.now()) {
  const maxDiffChars = parseInt(core.getInput('MAX_DIFF_CHARS'), 10) || 0;
  const token = core.getInput('GITHUB_TOKEN');
  core.setSecret(token);
  const reviewToken = core.getInput('GITHUB_REVIEW_TOKEN');
  if (reviewToken) {
    core.setSecret(reviewToken);
  }

  const { context } = github;
  const { owner, repo } = context.repo;
  const { pullNumber, headSha } = resolveReviewTarget(
    core.getInput('PR_NUMBER'),
    core.getInput('HEAD_SHA'),
    context.payload,
  );

  if (!Number.isInteger(pullNumber) || pullNumber <= 0 || !headSha) {
    core.setFailed(
      'Could not determine which pull request to review. On pull_request events this is '
      + 'detected automatically; on other events (e.g. workflow_run) pass PR_NUMBER and HEAD_SHA explicitly. '
      + 'For an on-demand whole-repo review with no PR, set MODE: repo.',
    );
    return;
  }

  const octokit = github.getOctokit(token);
  // [LAW:one-source-of-truth] "Which token posts the review" is decided HERE, once, and every consumer
  // reads this value. The identity set resolved below must name the account that actually posts, so a
  // second `reviewToken || token` spelled out at that call site would be a rival source: change the
  // fallback in one and the identity set silently stops covering the real poster — reintroducing the
  // very "our own block isn't ours" deadlock this identity gate exists to close.
  const postingToken = reviewToken || token;
  const reviewOctokit = github.getOctokit(postingToken);

  // [LAW:single-enforcer] One PR fetch, one place that decides fork eligibility. The PR object
  // also feeds config-file label/body selection below, so it is fetched once here.
  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }));
  } catch (e) {
    core.setFailed(`Failed to fetch PR #${pullNumber}: ${e.message}`);
    return;
  }

  // [LAW:one-type-per-behavior] The two exits that end a run WITHOUT reviewing — a fork PR and a spent
  // round cap — differ only in the notice VALUE they hand to announceNotReviewed. Both are still clean
  // exit-0 no-ops with no engine spawned; what changed is that the PR now says so, because a run that
  // reviewed nothing and a run that reviewed cleanly were otherwise identical at every sink a consumer
  // reads. [LAW:no-silent-failure]

  // [LAW:dataflow-not-control-flow] Fork eligibility is read from the PR data, not a mode: the
  // action never reviews a fork PR (its diff is untrusted and would spend the host's own AI credits
  // on outside contributors). Malformed PR data (no base repo) throws here and surfaces as a loud
  // failure, never a skip.
  //
  // This gate runs FIRST, deciding from the already-fetched `pr` alone, because "a fork PR is skipped,
  // unconditionally" is only as strong as the weakest thing the decision depends on. A prior-review
  // fetch in front of it would have made a transient API failure red a run that previously could not
  // fail — trading a load-bearing guarantee for a spam-avoidance key.
  let isFork;
  try {
    isFork = prIsFromFork(pr);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  if (isFork) {
    // forkNotice owns everything that makes this path different — including that it consults NO
    // idempotency key, since a fork PR's reviews are written by exactly the party who would want this
    // warning gone. There is no key parameter here to get wrong. [LAW:types-are-the-program]
    await announceNotReviewed(reviewOctokit, {
      owner, repo, pullNumber, commitId: headSha, reviewerName, notice: forkNotice(pullNumber),
    });
    return;
  }

  // [LAW:parse-dont-validate] Who this run posts as, resolved ONCE. It is what makes every marker below
  // attributable: without it, any account with read access could end a review body with REVIEW_MARKER
  // and forge a round — and enough forged rounds push a PR past its cap so it is never reviewed again.
  //
  // [LAW:one-source-of-truth] The DISTINCT tokens this run holds, deduped here where the token strings
  // live. The review token posts and the default token reads, and they are the same account until an
  // operator sets GITHUB_REVIEW_TOKEN — at which point earlier rounds of a live PR were posted by the
  // OTHER one. Resolving both is what keeps those rounds ours across that change; resolving only the
  // poster would disown them, resetting the count and stranding an outstanding block outside the set
  // releaseUnrevisitableBlocks can release. Identical tokens resolve once, so the ordinary run pays for
  // exactly one probe.
  //
  // Deliberately placed AFTER the fork gate. That gate decides from the already-fetched `pr` and nothing
  // else, on purpose: putting an API call in front of it would let a transient failure red a fork PR's
  // run, which is precisely the guarantee the fork path was built not to have.
  let identities;
  try {
    const distinctTokens = [...new Set([postingToken, token])];
    identities = await resolveReviewerIdentities(distinctTokens.map(t => github.getOctokit(t)));
  } catch (e) {
    core.setFailed(e.message);
    return;
  }

  // [LAW:no-silent-failure] Name the prior-review summary as the failure point, matching the PR fetch
  // above — a bare throw would surface only the generic top-level message, hiding which step failed. A
  // listReviews error fails the run loud rather than silently skipping the cap. ONE fetch feeds three
  // consumers: the round cap (.count), the PR-total footer (.cost), and the round-cap notice's
  // idempotency key (.latestArtifact). [LAW:one-source-of-truth]
  //
  // Fatal HERE, and not called at all on the fork path above: `count` gates spend, so an unknown count
  // must stop the run rather than re-review a PR that has already exhausted its cap. The fork path
  // needs nothing from this fetch (see its `latestArtifact: null`), which is why the fork gate can once
  // again depend on nothing but `pr`.
  let prior;
  try {
    prior = await summarizePriorReviews(octokit, owner, repo, pullNumber, identities);
  } catch (e) {
    core.setFailed(`Failed to summarize prior reviews for PR #${pullNumber}: ${e.message}`);
    return;
  }

  // [LAW:no-mode-explosion] Two independent opt-ins refine effort (PR mode only), both OFF by default and
  // both byte-identical when off: DIFFICULTY_SCALING PROPOSES a cheaper roundCap ceiling for easy diffs;
  // DAILY_BUDGET_USD CAPS effort as the day's budget depletes. They compose at this seam — difficulty
  // shapes the candidate ladder, budget picks the affordable best from it — and either activates the
  // other's off-value (difficulty off ⇒ the default de-rate ladder; budget off ⇒ an unbounded cap, so
  // the difficulty proposal stands). When BOTH are off the whole block is skipped: effort stays
  // `defaultEffort`, no diff fetch here, no ledger IO — a byte-identical run down to the log.
  // [LAW:no-silent-failure] each input is parsed strictly and reds the run loud on a malformed value.
  let dailyBudget;
  let difficultyScaling;
  let dependencyDiffOn;
  try {
    dailyBudget = parseDailyBudgetUsd(core.getInput('DAILY_BUDGET_USD'));
    difficultyScaling = parseDifficultyScaling(core.getInput('DIFFICULTY_SCALING'));
    dependencyDiffOn = parseDependencyDiffFlag(core.getInput('DEPENDENCY_DIFF'));
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  const budgetOn = dailyBudget > 0;
  let effort = defaultEffort;
  let fetched = null;      // fetchFilteredFiles' result — populated early only when this block is active
  let ledgerIssue = null;  // the issue this review's actual cost is appended to, after submit
  // [LAW:one-source-of-truth] The ceiling difficulty PROPOSED for this change, before any budget cap —
  // the most expensive candidate. It is `defaultEffort` unchanged when difficulty is off. The round-cap
  // gate below compares it against both the configured ceiling and the final effort to attribute a
  // de-rate to the lever that ACTUALLY bound (difficulty lowered this below the default; budget lowered
  // the final below this), so the skip message never names a knob that wasn't binding. [LAW:no-silent-failure]
  let difficultyCeiling = defaultEffort;
  if (budgetOn || difficultyScaling) {
    // Both features need the diff BEFORE the round-cap gate below (roundCap's only consumer): budget to
    // size this review's cost, difficulty to size the change. Fetched once here and reused downstream.
    fetched = await fetchFilteredFiles(octokit, owner, repo, pullNumber, excludePatterns);

    // [LAW:composability] Difficulty PROPOSES the candidate set; off ⇒ the default de-rate ladder, so a
    // budget-only run is byte-identical to before this slice. On the roundCap axis the proposal is anchored
    // to `defaultEffort` (the user's ceiling) so it only LOWERS; on the reasoningTier axis it RAISES a
    // complex diff above the config baseline (reconciled per-config at the runMultiScope fold).
    const candidates = difficultyScaling
      ? difficultyCandidates(assessDifficulty(fetched.filteredFiles), defaultEffort)
      : defaultBudgetCandidates(defaultEffort);

    // The roundCap CEILING difficulty proposed — the max-roundCap candidate, ranked in effectiveRounds
    // space so the 0="unlimited" sentinel ranks correctly. Only its roundCap is read (by bindingLevers,
    // which attributes the round-cap skip); the reasoning axis raises cost but never the round-cap gate,
    // so ties on roundCap (candidates differing only in reasoningTier) are interchangeable here.
    difficultyCeiling = candidates.reduce((a, b) =>
      (effectiveRounds(b.roundCap) > effectiveRounds(a.roundCap) ? b : a));

    if (budgetOn) {
      const rawIssue = core.getInput('LEDGER_ISSUE').trim();
      ledgerIssue = parseInt(rawIssue, 10);
      if (!rawIssue || !Number.isInteger(ledgerIssue) || ledgerIssue <= 0) {
        core.setFailed(
          `DAILY_BUDGET_USD is set (budget gradient enabled) but LEDGER_ISSUE is missing or invalid `
          + `(${JSON.stringify(rawIssue)}). Set LEDGER_ISSUE to the daily cost-ledger issue number `
          + '(e.g. from a repo Actions variable) — the gradient cannot ration spend without a ledger.',
        );
        return;
      }
      const now = new Date(); // [LAW:no-ambient-temporal-coupling] the run boundary owns the clock
      effort = await resolveBudgetedEffort({
        octokit, owner, repo, issueNumber: ledgerIssue, now,
        candidates, filteredFiles: fetched.filteredFiles, dailyBudget,
      });
    } else {
      // Difficulty-only: no daily budget to ration, so the difficulty-proposed ceiling stands.
      effort = resolveDifficultyEffort({ candidates, filteredFiles: fetched.filteredFiles });
    }
  }

  // [LAW:single-enforcer] The round-cap gate reads the RESOLVED effort's roundCap — the refined cap when
  // budget and/or difficulty is active, else the default from MAX_REVIEW_ROUNDS — so a depleting budget or
  // an easy diff de-rates by tripping this same gate sooner. [LAW:no-silent-failure] the message names the
  // ACTUAL binding constraint, attributed PRECISELY: two levers can lower the cap, but each only when it
  // genuinely bound. Difficulty bound iff its proposed ceiling fell below MAX_REVIEW_ROUNDS; budget bound
  // iff the final cap fell below whatever difficulty proposed. Compared in effectiveRounds space so the
  // 0=unlimited sentinel ranks correctly. Naming a lever that was active-but-non-binding (e.g. "raise the
  // budget" when an easy diff — not the budget — set the cap) would send the user down the wrong path.
  // [LAW:dataflow-not-control-flow] the message varies by the VALUE of the binding-lever list; `deRated`
  // implies exactly the union of the two bound flags (effort is only lowered inside the block above, and
  // it can only fall via the difficulty ceiling or the budget cap), so the list is never empty here. The
  // both-off path leaves the cap at the default and takes the MAX_REVIEW_ROUNDS branch (a byte-identical
  // run down to the log).
  //
  // The cap itself is a cost control worth keeping: a weak model surfaces everything important in the
  // first few rounds, and re-reviewing every push past that re-spends the diff's full token cost for
  // diminishing return. The rounds already spent are derived from the PR's marker-bearing reviews (one
  // review per round) — never a separate counter. What the cap must NOT do is go quiet, which is why the
  // exit announces itself below rather than only logging. [LAW:no-silent-failure]
  if (roundCapReached(prior.count, effort.roundCap)) {
    const { deRated, budgetBound, difficultyBound } = bindingLevers({
      effortRoundCap: effort.roundCap,
      difficultyCeilingRoundCap: difficultyCeiling.roundCap,
      defaultRoundCap: defaultEffort.roundCap,
    });
    const setters = [
      budgetBound && 'the DAILY_BUDGET_USD gradient',
      difficultyBound && 'DIFFICULTY_SCALING',
    ].filter(Boolean);
    const remedies = [
      budgetBound && 'raise the daily budget',
      difficultyBound && 'push a larger change (or unset DIFFICULTY_SCALING)',
    ].filter(Boolean);
    // [LAW:one-source-of-truth] The cap sentence is composed ONCE and read by both sinks — the run log
    // and the notice posted to the PR — so the operator remedy can never differ between the two places
    // it appears. announceNotReviewed owns the logging, so this site only produces the value.
    const message = deRated
      ? `PR #${pullNumber} has already been reviewed ${prior.count} time(s), reaching `
        + `the de-rated round cap of ${effort.roundCap} set by ${setters.join(' / ')} (lowered from `
        + `MAX_REVIEW_ROUNDS ${defaultEffort.roundCap}). To review further pushes, ${remedies.join(' or ')}.`
      : `PR #${pullNumber} has already been reviewed ${prior.count} time(s), reaching `
        + `the MAX_REVIEW_ROUNDS cap of ${effort.roundCap}. Raise MAX_REVIEW_ROUNDS (0 = unlimited) to review further pushes.`;
    const noticeResult = await announceNotReviewed(reviewOctokit, {
      owner, repo, pullNumber, commitId: headSha, reviewerName,
      notice: roundCapNotice(message, prior.latestArtifact),
    });
    // A block is released only once its explanation actually reached the PR. `announceNotReviewed`
    // reports a failed post via `setFailed` rather than throwing (roundCapNotice's postFailureHint is a
    // remedy for THAT failure, and a throw here would skip straight past it), so nothing upstream stops
    // this function on 'failed' by itself — this check is what makes the sequencing in the comment below
    // ("say it, then stop enforcing it") true of the code and not just of the comment. Skipping the
    // release leaves the block in place, which is the safe direction: the PR stays exactly as gated as it
    // was, rather than losing its merge block with no visible reason on the PR. The next push re-attempts
    // the notice (this round never became the newest artifact) and, once it posts, releases then.
    // [LAW:no-silent-failure]
    if (noticeResult === 'failed') return;
    // Say it, then stop enforcing it. Announcing that the PR will not be reviewed again while still
    // holding a REQUEST_CHANGES against it is the deadlock this exit used to create: the cap can even
    // shrink BENEATH a block already posted (a first round costing enough to de-rate the cap to 1 leaves
    // round 1's rejection permanently unsupersedable), so refusing to post the final round's block would
    // not have covered this. Releasing at the moment the action declines to look again covers every path
    // to it, which is why this is the only enforcement site. [LAW:single-enforcer]
    //
    // The transport is reused when the budget/difficulty phase already selected one, and selected here
    // otherwise — the same fetch-once-reuse shape the review path uses below. This is the skip path only;
    // the reviewing path is untouched. [LAW:one-source-of-truth]
    //
    // The transport is passed as a THUNK, not resolved here: only the release knows whether this PR has
    // anything outstanding, and the common capped push has nothing — resolving a transport for it would
    // re-list every changed file on every push forever to build a route that is never called. The budget
    // phase's transport is reused when that phase ran, so the thunk costs a fetch only on the rare push
    // that genuinely has a block to release. [LAW:carrying-cost]
    await releaseUnrevisitableBlocks(reviewOctokit, () => (fetched
      ? fetched.transport
      : selectTransport(octokit, owner, repo, pullNumber)), {
      owner, repo, pullNumber, reviews: prior.reviews, capMessage: message,
      commitId: headSha, reviewerName, releaseFailureBodies: prior.releaseFailureBodies,
    });
    return;
  }

  let chain;
  try {
    chain = buildConfigChain({ labels: pr.labels, body: pr.body });
  } catch (e) {
    core.setFailed(e.message);
    return;
  }

  if (!(await preflightChain(chain))) return;

  // [LAW:one-source-of-truth] The reviewed diff is fetched once: reuse the budget phase's fetch when the
  // gradient is active, otherwise fetch here in its original post-preflight position (off path unchanged).
  const { transport, filteredFiles, excluded } = fetched
    || await fetchFilteredFiles(octokit, owner, repo, pullNumber, excludePatterns);

  // [LAW:single-enforcer] "reviewable" is defined ONCE, downstream in buildReviewInput, where a changed
  // file GitHub returned without a patch (too large — roughly >400 changed lines — or binary) is a
  // first-class review target: read in full at its absolute path, reported at its real line numbers.
  // This gate holds no second, stricter definition. It rejects only what the engine genuinely cannot
  // review — an empty changed-file set. Filtering on `f.patch` here APPROVED the exact case the engine
  // handles, and did so most readily on the largest, riskiest changes.
  // [LAW:no-silent-failure] The refusals travel even on the nothing-to-review path — especially here.
  // "Every changed file was refused" reaches this branch looking exactly like "the PR is empty", and
  // approving it would be approving a PR nobody looked at.
  if (filteredFiles.length === 0) {
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, {
      summary: 'This pull request changed no reviewable files.',
      findings: [],
      unreviewedScopes: [],
      unreviewableFiles: transport.unreviewable,
    }, Boolean(reviewToken), transport);
    return;
  }

  // Anchors are engine-agnostic (purely diff-line based), so they are computed once here from any
  // toolNames; the material rebuilds the worker prompt per attempt so each engine gets its own tool
  // identifiers. [LAW:types-are-the-program] [LAW:no-ambient-temporal-coupling] runMultiScope (via
  // produceReview) owns retry timing; the whole scout→workers pass is one attempt per config.
  const anchorInput = buildReviewInput({ files: filteredFiles, maxDiffChars, toolNames: registry.get(chain[0].engine).toolNames, reviewedRepoRoot: REVIEWED_REPO_ROOT });
  const anchors = buildReviewAnchors(anchorInput.files);
  const dependencySummaries = await resolveDependencySummaries(octokit, filteredFiles, dependencyDiffOn);
  // [LAW:dataflow-not-control-flow] Prior-round pushbacks (the PR author's replies to earlier findings)
  // feed this round's workers so RA stops re-litigating soundly-rebutted points. The pairing is keyed by
  // IDENTITY: findings are the inline comments of RA's marker-bearing reviews (prior.reviews), and a
  // pushback is a reply authored by the PR author (pr.user.login) — so a human reviewer's thread or a
  // bystander's reply is never misattributed as RA's finding / the author's rebuttal. The fetch is gated on
  // prior.count: with zero prior RA reviews there are no findings and thus no replies, so the result is
  // provably [] — the gate skips one round-trip on the common first review, mirroring how the budget block
  // above only does its IO when active.
  //
  // [LAW:no-silent-failure] Pushbacks are ADDITIVE context, not a gate: unlike the PR fetch and
  // summarizePriorReviews (which gate the review's existence and the round cap, so they core.setFailed),
  // a review is fully correct WITHOUT them — [] yields the same byte-identical cold review a PR with no
  // pushbacks gets. So a listReviewComments failure degrades to [] with a LOUD, PR-named warning rather
  // than aborting a paid review cycle for optional context. This is not a silent `|| []`: the warning
  // announces the degradation, and [] is an HONEST "no pushback context this round", never wrong data.
  let priorPushbacks = [];
  if (prior.count > 0) {
    try {
      priorPushbacks = await fetchPriorPushbacks(octokit, owner, repo, pullNumber, { findingReviewIds: prior.reviews.map(r => r.id), authorLogin: pr.user?.login });
    } catch (e) {
      core.warning(`Failed to fetch prior-round pushbacks for PR #${pullNumber}: ${e.message}. Proceeding without pushback context.`);
    }
  }
  const material = buildPrMaterial({ files: filteredFiles, maxDiffChars, reviewedRepoRoot: REVIEWED_REPO_ROOT, dependencySummaries, priorPushbacks, excluded });

  // [LAW:one-source-of-truth] The engine owns review judgment; the action owns GitHub transport.
  core.info(`Running multi-scope PR review for ${filteredFiles.length} file(s) with ${chain.length} config(s) in chain...`);
  const { review, configUsed } = await runMultiScope({
    chain, material, registry, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, effort, log: core.info, deadline, startedAt,
  });
  warnBudgetExhausted(review);

  // [LAW:single-enforcer] The PR sink reconciles the MERGED findings with the diff anchors exactly
  // once, here at the boundary: anchored (incl. snapped) post inline; unanchored surface in the
  // summary. [LAW:dataflow-not-control-flow] a finding the model anchored outside the diff is a value
  // routed to the summary, never a fatal that aborts the review. [LAW:no-silent-failure] each
  // unanchored finding is logged, never dropped — and still counts toward the verdict in submitReview.
  const { anchored, unanchored } = partitionFindings(review.findings, anchors);
  for (const f of unanchored) {
    core.warning(`Finding references ${f.path}:${f.line}, outside the reviewed diff — surfaced in the review summary instead of inline.`);
  }

  // [LAW:one-source-of-truth] The dependency section is assembled once here, at the sink, from the SAME
  // structured summaries the prompt note derived from — now enriched by the workers' per-module
  // assessments. '' for a non-dependency PR, so the posted body is byte-identical to before. [LAW:dataflow-not-control-flow]
  const dependencySection = renderDependencyReviewSection(dependencySummaries, review.assessments);
  // totalMs is read HERE, at the last instant before the sink, so the total covers everything the
  // run did up to submission — the same clock startedAt came from, read once. [LAW:one-source-of-truth]
  const footer = buildReviewFooter(review.usage, configUsed, prior.cost, { schedule: review.schedule, totalMs: Date.now() - startedAt, priorDuration: prior.duration });
  await submitReview(
    reviewOctokit, owner, repo, pullNumber, headSha, reviewerName,
    // [LAW:dataflow-not-control-flow] Coverage is stated, never inferred: the engine's own gap
    // (unreviewedScopes) and the diff boundary's (transport.unreviewable) both reach the sink as values,
    // and the sink alone decides what they mean for approval.
    { summary: review.summary, findings: anchored, unanchored, dependencySection, unreviewedScopes: review.unreviewedScopes, unreviewableFiles: transport.unreviewable },
    Boolean(reviewToken), transport, footer,
  );

  // [LAW:effects-at-boundaries] Append THIS review's actual cost to the daily ledger, AFTER submit — the
  // cost is known only now. Only when the budget gradient is active (ledgerIssue set). [LAW:no-silent-failure]
  // a failed append warns and continues: the day's ledger becomes a known LOWER bound, never a review
  // aborted for a bookkeeping write. The cost VALUE is the one the footer already reported — never re-estimated.
  if (ledgerIssue !== null) {
    try {
      await appendCost(octokit, owner, repo, ledgerIssue, review.usage, configUsed);
    } catch (e) {
      core.warning(
        `Budget: failed to append this review's cost to ledger issue #${ledgerIssue} (${e.message}) — `
        + "the day's ledger now UNDER-counts by this review (a known lower bound). Verify issues:write access.",
      );
    }
  }
}

// Whole-repo review: no PR, no fork gate, no host transport. Build a repo-exploration prompt
// (optionally scoped), run the same engine chain, and print the report to the Step Summary + logs.
// `startedAt` carries the same contract as runPrReview's: the run's one start instant, defaulted
// at this entry only for direct callers whose run boundary this is. [LAW:no-ambient-temporal-coupling]
async function runRepoReview(reviewerName, excludePatterns, effort, deadline, startedAt = Date.now()) {
  const scope = core.getInput('SCOPE').trim();

  let chain;
  try {
    // [LAW:dataflow-not-control-flow] No PR means no per-PR selectors; the same selectConfig runs
    // with empty labels/body, so the file default or explicit CONFIG input decides the engine.
    chain = buildConfigChain({ labels: [], body: '' });
  } catch (e) {
    core.setFailed(e.message);
    return;
  }

  if (!(await preflightChain(chain))) return;

  // No diff means no anchors; the material's scout surveys the tree and each worker reviews one scope
  // by absolute path, rebuilding its prompt per engine so each gets its own tool identifiers. [LAW:composability]
  const material = buildRepoMaterial({ scope, excludePatterns, reviewedRepoRoot: REVIEWED_REPO_ROOT });

  core.info(
    `Running multi-scope whole-repo review with ${chain.length} config(s) in chain`
    + `${scope ? ` (scope: ${scope})` : ' (whole repository)'}...`,
  );
  const { review, configUsed } = await runMultiScope({
    chain, material, registry, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, effort, log: core.info, deadline, startedAt,
  });
  warnBudgetExhausted(review);

  const footer = buildReviewFooter(review.usage, configUsed, null, { schedule: review.schedule, totalMs: Date.now() - startedAt });
  const report = renderRepoReport({ reviewerName, scope, review, footer });

  // [LAW:effects-at-boundaries] The printed sink: the report goes to the run log and the Step
  // Summary (the maintainer-facing output for a manual run). [LAW:no-silent-failure] findings are
  // surfaced loudly here; there is no PR to mark, so the run stays informational (exit 0). The log
  // is written first so findings are never lost if the Step Summary write fails (e.g. an
  // environment with GITHUB_STEP_SUMMARY unset surfaces its error loudly, after the log is on record).
  core.info(report);
  core.info(`Whole-repo review complete: ${review.findings.length} finding(s).`);
  await core.summary.addRaw(report).write();
}

async function run() {
  // [LAW:effects-at-boundaries] The transcript directory is a fixed, well-known path (TRANSCRIPT_DIR),
  // so the step output is set once here at the entry boundary — before any engine spawn, fork-skip, or
  // failure — guaranteeing an `if: always()` upload step a path to point at on every termination path.
  // The directory may legitimately be empty (a run that spawned no engine); the upload step's
  // if-no-files-found handles that. [LAW:no-silent-failure] the path is never conditional on success.
  core.setOutput('transcript-dir', TRANSCRIPT_DIR);

  // [LAW:parse-dont-validate] The raw input crosses into a real name exactly here, once, before either
  // mode can carry it to a renderer. See parseReviewerName (transport.js) for why a blank must not
  // reach one and why the default's only home is that module rather than action.yml.
  const reviewerName = parseReviewerName(core.getInput('ZAI_REVIEWER_NAME'));
  const excludePatterns = core.getInput('EXCLUDE_PATTERNS')
    .split(',')
    .map(p => p.trim())
    .filter(p => p.length > 0);

  // [LAW:types-are-the-program] MODE is the explicit discriminator between the two review materials
  // and sinks. It is read as a value, never inferred from "is a PR present" — inferring would turn a
  // misconfigured PR run into an accidental whole-repo audit. [LAW:no-silent-failure] an unknown
  // value fails loud rather than defaulting silently.
  const mode = (core.getInput('MODE') || 'pr').trim();

  // [LAW:single-enforcer] The review's effort profile is produced ONCE here, at the top of the run,
  // and threaded into whichever mode runs — the single seam where "how much effort to spend on this
  // review" is decided. Simple mode uses the default; the config-file override is a later increment.
  // [LAW:no-silent-failure] roundCap is validated at THIS producing boundary — the raw MAX_REVIEW_ROUNDS
  // input is parsed strictly here and the integer folded into the profile, so the round-cap consumer
  // (the pre-spawn gate in runPrReview) reads a trusted value off the profile and never re-parses or
  // guards. A malformed input reds the run loud rather than silently disabling the cap.
  // [LAW:no-ambient-temporal-coupling] The review's wall-clock deadline, minted exactly ONCE at the
  // run boundary (the same boundary that owns `new Date()` for the budget ledger) and threaded down
  // as an absolute value — so every phase, pre-review included, spends from the same clock. It exists
  // so the run finishes and SUBMITS before the workflow's timeout-minutes cancel, which can only
  // discard collected findings. null (TIME_BUDGET_MINUTES: 0) disables it — bit-for-bit the
  // pre-budget behavior. [LAW:one-source-of-truth] The mint shares the parses' failure path: it is
  // the boundary that proves the deadline SUM sound (deadline.js), and its refusal is the same
  // misconfiguration class as a malformed input.
  // The run's start instant is the SAME mint the deadline spends from — one clock read, two
  // consumers (the budget's horizon, the timing footer's total) — never a second Date.now()
  // that could disagree with it. [LAW:one-source-of-truth] (zai-timing-31d.6)
  const startedAt = Date.now();
  let roundCap;
  let deadline;
  try {
    roundCap = parseMaxRounds(core.getInput('MAX_REVIEW_ROUNDS'));
    deadline = mintDeadline(startedAt, parseTimeBudgetMinutes(core.getInput('TIME_BUDGET_MINUTES')));
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  const effort = defaultEffortProfile({ roundCap });

  if (mode === 'pr') {
    await runPrReview(reviewerName, excludePatterns, effort, deadline, startedAt);
  } else if (mode === 'repo') {
    await runRepoReview(reviewerName, excludePatterns, effort, deadline, startedAt);
  } else {
    core.setFailed(`Invalid MODE '${mode}'. Valid values: 'pr' (review a pull request) or 'repo' (whole-repo review).`);
  }
}

module.exports = { run, runPrReview, buildReviewFooter, resolveBudgetedEffort, resolveDifficultyEffort, bindingLevers, resolveDependencySummaries, warnBudgetExhausted, MAX_DEPENDENCY_BUMPS_FETCHED };
