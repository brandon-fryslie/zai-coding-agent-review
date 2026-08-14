'use strict';
const core = require('@actions/core');
const github = require('@actions/github');
const fs = require('fs');
const path = require('path');

const { filterFiles, buildReviewAnchors, diffChurn } = require('./diff');
const { selectTransport, submitReview, resolveReviewTarget, prIsFromFork, summarizePriorReviews, fetchPriorPushbacks, roundCapReached, parseMaxRounds } = require('./transport');
const { buildReviewInput } = require('./prompt');
const { partitionFindings } = require('./review');
const { buildAttributionFooter } = require('./failover');
const { runMultiScope, buildPrMaterial, buildRepoMaterial } = require('./multiscope');
const { defaultEffortProfile } = require('./effort');
const { parseDailyBudgetUsd, defaultBudgetCandidates, chooseProfile, effectiveRounds } = require('./budget');
const { assessDifficulty } = require('./difficulty');
const { difficultyCandidates, parseDifficultyScaling } = require('./difficulty-policy');
const { readSpentToday, appendCost } = require('./ledger');
const { parseDependencyDiffFlag, parseGoModBumps, fetchUpstreamChangeSummary, renderDependencyReviewSection } = require('./dependency-diff');
const { renderCostLine, costWarning, costMarker } = require('./usage');
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
    chain.forEach(c => core.setSecret(c.endpoint.apiKey));
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
  });
  core.setSecret(config.endpoint.apiKey);
  core.info(`Using provider '${config.name}' (engine: ${config.engine}, model: ${config.model}).`);
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
function buildReviewFooter(usage, configUsed, priorCost = null) {
  const warning = costWarning(usage, configUsed);
  if (warning) core.warning(warning);
  const costLine = renderCostLine(usage, configUsed, priorCost);
  if (costLine) core.info(costLine.replace(/^_|_$/g, ''));
  const marker = costMarker(usage && usage.cost);
  return [buildAttributionFooter(configUsed), costLine, marker].filter(Boolean).join('\n\n');
}

// [LAW:one-source-of-truth] The budget-exhaustion warning, composed ONCE for both review modes from
// the review's coverage data plus the one remedy sentence (BUDGET_REMEDY, src/deadline.js) — never
// re-authored per sink, so the operator remedy cannot drift between modes or from the error
// messages that share it. [LAW:no-silent-failure] the budget biting is operator news, not just
// review-body prose: the warning makes a curtailed review visible in the run's annotations.
function warnBudgetExhausted(review) {
  if (!review.budgetExhausted) return;
  core.warning(
    `Review time budget exhausted: ${review.unreviewedScopes.length} scope(s) went unreviewed`
    + `${review.unreviewedScopes.length > 0 ? ` (${review.unreviewedScopes.join(', ')})` : ''}. `
    + `The collected findings were still delivered. ${BUDGET_REMEDY}`,
  );
}

// [LAW:decomposition] The one fetch site for the reviewed diff: select the host transport, pull the
// changed files, apply EXCLUDE_PATTERNS, and emit the "fetching"/"excluded" logs. runPrReview calls it
// exactly once — the budget phase (when active) needs the diff BEFORE the round-cap gate to size the
// review's cost, so it fetches here early and the downstream review reuses the result; when budget is
// off, this runs in its original post-preflight position, unchanged. [LAW:one-source-of-truth]
async function fetchFilteredFiles(octokit, owner, repo, pullNumber, excludePatterns) {
  core.info(`Fetching changed files for PR #${pullNumber}...`);
  const transport = await selectTransport(octokit, owner, repo, pullNumber);
  const filteredFiles = filterFiles(transport.files, excludePatterns);
  if (excludePatterns.length > 0) {
    const excluded = transport.files.length - filteredFiles.length;
    if (excluded > 0) core.info(`Excluded ${excluded} file(s) matching EXCLUDE_PATTERNS.`);
  }
  return { transport, filteredFiles };
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
    spentToday = ledger.usd;
    if (ledger.unknownEntries > 0) {
      core.warning(
        `Budget: ledger issue #${issueNumber} has ${ledger.unknownEntries} entr(ies) with unknown cost — `
        + `today's spend ($${spentToday.toFixed(4)}) is a LOWER bound; the gradient rations at least this cautiously.`,
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
  const skipped = bumps.slice(MAX_DEPENDENCY_BUMPS_FETCHED).map(b => ({
    ...b, resolved: false, reason: `upstream context not fetched — this PR bumps more than ${MAX_DEPENDENCY_BUMPS_FETCHED} modules`,
  }));
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
async function runPrReview(reviewerName, excludePatterns, defaultEffort, deadline) {
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
  const reviewOctokit = github.getOctokit(reviewToken || token);

  // [LAW:single-enforcer] One PR fetch, one place that decides fork eligibility. The PR object
  // also feeds config-file label/body selection below, so it is fetched once here.
  let pr;
  try {
    ({ data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }));
  } catch (e) {
    core.setFailed(`Failed to fetch PR #${pullNumber}: ${e.message}`);
    return;
  }

  // [LAW:dataflow-not-control-flow] Fork eligibility is read from the PR data, not a mode: the
  // action never reviews a fork PR (its diff is untrusted and would spend the host's own AI credits
  // on outside contributors). Skipping is an intentional clean no-op — logged, exit 0, no review
  // posted, no engine spawned. [LAW:no-silent-failure] the skip is announced; malformed PR data (no
  // base repo) throws here and surfaces as a loud failure, never a skip.
  let isFork;
  try {
    isFork = prIsFromFork(pr);
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  if (isFork) {
    core.info(
      `Skipping review: PR #${pullNumber} is from a fork. Fork pull requests are not reviewed `
      + 'by this action.',
    );
    return;
  }

  // [LAW:dataflow-not-control-flow] The round cap is the same clean pre-spawn skip as the fork gate:
  // the number of rounds already spent is derived from the PR's marker-bearing reviews (one review per
  // round), and a maxed-out PR is a logged no-op — exit 0, no engine spawned, the last review's verdict
  // stands. [LAW:no-silent-failure] the skip names the cap so a missing review is never mistaken for a
  // clean pass. A weak model surfaces everything important in the first few rounds; beyond the cap,
  // re-reviewing every push only re-spends the diff's full token cost for diminishing return.
  // [LAW:single-enforcer] The cap is read off the effort profile — parsed and validated once at the
  // producing boundary in run() — never re-parsed here.
  // [LAW:no-silent-failure] Name the prior-review summary as the failure point, matching the fork-gate
  // fetch above — a bare throw would surface only the generic top-level message, hiding which step
  // failed. A listReviews error fails the run loud rather than silently skipping the cap. One fetch
  // feeds both the round cap (.count) and the PR-total footer (.cost). [LAW:one-source-of-truth]
  let prior;
  try {
    prior = await summarizePriorReviews(octokit, owner, repo, pullNumber);
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
  let fetched = null;      // { transport, filteredFiles } — populated early only when this block is active
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
    core.info(deRated
      ? `Skipping review: PR #${pullNumber} has already been reviewed ${prior.count} time(s), reaching `
        + `the de-rated round cap of ${effort.roundCap} set by ${setters.join(' / ')} (lowered from `
        + `MAX_REVIEW_ROUNDS ${defaultEffort.roundCap}). To review further pushes, ${remedies.join(' or ')}.`
      : `Skipping review: PR #${pullNumber} has already been reviewed ${prior.count} time(s), reaching `
        + `the MAX_REVIEW_ROUNDS cap of ${effort.roundCap}. Raise MAX_REVIEW_ROUNDS (0 = unlimited) to review further pushes.`);
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
  const { transport, filteredFiles } = fetched
    || await fetchFilteredFiles(octokit, owner, repo, pullNumber, excludePatterns);

  const patchableFiles = filteredFiles.filter(f => f.patch);

  if (patchableFiles.length === 0) {
    await submitReview(reviewOctokit, owner, repo, pullNumber, headSha, reviewerName, {
      summary: 'No patchable changes found after filtering.',
      findings: [],
      unreviewedScopes: [],
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
  // IDENTITY: findings are the inline comments of RA's marker-bearing reviews (prior.reviewIds), and a
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
      priorPushbacks = await fetchPriorPushbacks(octokit, owner, repo, pullNumber, { findingReviewIds: prior.reviewIds, authorLogin: pr.user?.login });
    } catch (e) {
      core.warning(`Failed to fetch prior-round pushbacks for PR #${pullNumber}: ${e.message}. Proceeding without pushback context.`);
    }
  }
  const material = buildPrMaterial({ files: filteredFiles, maxDiffChars, reviewedRepoRoot: REVIEWED_REPO_ROOT, dependencySummaries, priorPushbacks });

  // [LAW:one-source-of-truth] The engine owns review judgment; the action owns GitHub transport.
  core.info(`Running multi-scope PR review for ${filteredFiles.length} file(s) with ${chain.length} config(s) in chain...`);
  const { review, configUsed } = await runMultiScope({
    chain, material, registry, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, effort, log: core.info, deadline,
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
  const footer = buildReviewFooter(review.usage, configUsed, prior.cost);
  await submitReview(
    reviewOctokit, owner, repo, pullNumber, headSha, reviewerName,
    { summary: review.summary, findings: anchored, unanchored, dependencySection, unreviewedScopes: review.unreviewedScopes },
    Boolean(reviewToken), transport, footer,
  );

  // [LAW:effects-at-boundaries] Append THIS review's actual cost to the daily ledger, AFTER submit — the
  // cost is known only now. Only when the budget gradient is active (ledgerIssue set). [LAW:no-silent-failure]
  // a failed append warns and continues: the day's ledger becomes a known LOWER bound, never a review
  // aborted for a bookkeeping write. The cost VALUE is the one the footer already reported — never re-estimated.
  if (ledgerIssue !== null) {
    try {
      await appendCost(octokit, owner, repo, ledgerIssue, review.usage && review.usage.cost);
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
async function runRepoReview(reviewerName, excludePatterns, effort, deadline) {
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
    chain, material, registry, instructionsPath: REVIEW_AGENT_INSTRUCTIONS_PATH, effort, log: core.info, deadline,
  });
  warnBudgetExhausted(review);

  const footer = buildReviewFooter(review.usage, configUsed);
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

  const reviewerName = core.getInput('ZAI_REVIEWER_NAME');
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
  let roundCap;
  let budgetMinutes;
  try {
    roundCap = parseMaxRounds(core.getInput('MAX_REVIEW_ROUNDS'));
    budgetMinutes = parseTimeBudgetMinutes(core.getInput('TIME_BUDGET_MINUTES'));
  } catch (e) {
    core.setFailed(e.message);
    return;
  }
  const effort = defaultEffortProfile({ roundCap });
  // [LAW:no-ambient-temporal-coupling] The review's wall-clock deadline, minted exactly ONCE at the
  // run boundary (the same boundary that owns `new Date()` for the budget ledger) and threaded down
  // as an absolute value — so every phase, pre-review included, spends from the same clock. It exists
  // so the run finishes and SUBMITS before the workflow's timeout-minutes cancel, which can only
  // discard collected findings. null (TIME_BUDGET_MINUTES: 0) disables it — bit-for-bit the
  // pre-budget behavior. [LAW:one-source-of-truth]
  const deadline = mintDeadline(Date.now(), budgetMinutes);

  if (mode === 'pr') {
    await runPrReview(reviewerName, excludePatterns, effort, deadline);
  } else if (mode === 'repo') {
    await runRepoReview(reviewerName, excludePatterns, effort, deadline);
  } else {
    core.setFailed(`Invalid MODE '${mode}'. Valid values: 'pr' (review a pull request) or 'repo' (whole-repo review).`);
  }
}

module.exports = { run, resolveBudgetedEffort, resolveDifficultyEffort, bindingLevers, resolveDependencySummaries, MAX_DEPENDENCY_BUMPS_FETCHED };
