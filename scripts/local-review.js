#!/usr/bin/env node
'use strict';
// Run a FAITHFUL review locally — the real engine, the real prompt, the real collector — against a
// real diff, with NO GitHub. It answers the diagnostic question "what does the engine actually do?":
// it reports, per attempt, whether the engine explored the repo (Read/Grep/Glob) or reviewed the
// inline diff only, alongside the findings it produced and the cost.
//
// It reuses the action's own seams — synthesizeProviderConfig (config), parseUnifiedDiff (diff), and
// runMultiScope (the SAME adaptive multi-scope engine production runs) — so its behavior matches a
// production run for the same inputs. [LAW:one-source-of-truth] Nothing about config, diffs, prompts,
// or the scout→workers pass is reimplemented here.
//
// [LAW:one-type-per-behavior] Both modes drive runMultiScope and differ ONLY in the material (a PR
// diff vs the repo tree) — the exact differential run.js has. So either mode is equally drivable here;
// it is never possible to exercise one mode locally but not the other.
//
//   node scripts/local-review.js [--provider auto] [--range "HEAD~1 HEAD"] [--repo .] [--mode pr|repo]
//
// The provider credential is read from the same env var the action uses
// (DEEPSEEK_API_KEY / ZAI_API_KEY / OPENAI_API_KEY). See --help.
//
// [LAW:effects-at-boundaries] Module load is PURE: only stdlib + the pure session-stats helper and
// function definitions. Every world-effect (temp dirs, env mutation, IO) and every engine-stack
// require lives inside main(), the entry boundary — so importing this file for the pure-helper tests
// (parseArgs/formatReport) performs no IO, mutates no globals, and loads no engine stack.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { summarizeSession } = require('./session-stats');

const USAGE = `Run a faithful local review (real engine, real collector, no GitHub) and report whether
the engine explored the repo or reviewed the diff only.

Usage: node scripts/local-review.js [options]

  --provider <name>   Provider: auto (default), deepseek, zai, codex, claude-subscription. Credential
                      read from the matching env var: DEEPSEEK_API_KEY / ZAI_API_KEY /
                      OPENAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.
  --config <file>     Load a CONFIG_FILE-format YAML (the same loader production runs use) instead of
                      a provider preset. Mutually exclusive with --provider/--model/--base-url — those
                      values live in the file.
  --use <name>        Config name to select from --config (default: the file's 'default').
  --range <expr>      git diff range for the material (default: "HEAD~1 HEAD"). Ignored in repo mode.
  --diff <file>       Use a unified .diff file instead of computing one from --range.
  --repo <path>       Reviewed repo root (default: current directory). Read by the engine by absolute path.
  --mode <pr|repo>    Review mode (default: pr). repo = whole-repo exploration, no diff.
  --scope <text>      Optional free-text scope, repo mode only.
  --workers <N>       Max concurrent scope workers (default: 4).
  --model <id>        Override the provider's default model.
  --base-url <url>    Override the provider's endpoint base URL (api-key providers only).
  --help              Show this help.
`;

// [LAW:effects-at-boundaries] Pure arg parse: flags map to a plain options value; no IO, no defaults
// that touch the world. `--flag value` and `--flag=value` both supported.
function parseArgs(argv) {
  const opts = { provider: 'auto', range: 'HEAD~1 HEAD', repo: process.cwd(), mode: 'pr', scope: '', workers: 4 };
  const known = new Set(['provider', 'range', 'diff', 'repo', 'mode', 'scope', 'workers', 'model', 'base-url', 'config', 'use']);
  // The options that pick between two sources via truthiness downstream — see the rejection below.
  const NON_EMPTY_OPTIONS = new Set(['config', 'use', 'diff', 'base-url', 'model', 'provider']);
  const written = new Set(); // flag names the caller actually typed, for exclusivity checks below
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${name} requires a value.`);
    // [LAW:parse-dont-validate] For these options an empty value is almost always an unset shell
    // variable (`--config "$CFG"`), and every downstream discriminator on them is a truthiness
    // check — an empty string would slip past all of them (the --config exclusivity guard, the
    // --diff vs --range pick, the pinned-base-url guard, the model override) and silently select
    // the OTHER source. Reject it here, at the parse boundary, so empty is unrepresentable inland
    // and those truthiness checks stay exact. The set is only the two-source options: for the rest
    // (scope, repo, range, mode, workers) empty either equals the default or already fails loudly.
    if (value === '' && NON_EMPTY_OPTIONS.has(name)) throw new Error(`Option --${name} requires a non-empty value.`);
    written.add(name);
    opts[name === 'base-url' ? 'baseUrl' : name] = value;
  }
  // [LAW:no-silent-failure] --config and the preset flags are two sources for the same facts
  // (provider, model, endpoint). Accepting both and letting one win would leave the operator
  // believing the loser took effect — reject the combination outright. [LAW:one-source-of-truth]
  if (opts.config) {
    const clash = ['provider', 'model', 'base-url'].filter(f => written.has(f));
    if (clash.length > 0) {
      throw new Error(`--config is mutually exclusive with ${clash.map(f => `--${f}`).join(', ')}: those values come from the config file.`);
    }
  } else if (opts.use) {
    throw new Error('--use selects a config from --config; pass --config <file> with it.');
  }
  if (opts.mode !== 'pr' && opts.mode !== 'repo') throw new Error(`--mode must be 'pr' or 'repo' (got '${opts.mode}').`);
  // [LAW:no-silent-failure] A pinned provider reads no base URL — accepting the flag and quietly
  // dropping it would leave the operator believing they had redirected the endpoint.
  // [LAW:one-source-of-truth] WHICH providers those are is not a name to hardcode: it is the preset's
  // pinned `baseUrl`, read from the same table src/provider.js resolves every endpoint from, so a
  // future pinned provider is covered the day its row lands. The require is lazy to keep module load
  // free of the engine stack (see the header); parseArgs stays pure — a require performs no IO here.
  if (opts.baseUrl) {
    const { PROVIDERS, PRESETS, PROVIDER_ALIASES } = require('../src/provider');
    // Resolve the alias FIRST. The default provider is 'auto', which forwards to a concrete row — ask
    // before resolving and the common no-`--provider` invocation slips past this guard entirely.
    const requested = opts.provider;
    const provider = PROVIDER_ALIASES[requested] || requested;
    // An unknown provider is not this guard's business: synthesizeProviderConfig rejects it loudly,
    // naming every valid value. Duplicating that here would be a second enforcer of one rule.
    const spec = PROVIDERS[provider];
    const pinned = spec && PRESETS[spec.preset].baseUrl;
    if (pinned) {
      const label = requested === provider ? `'${provider}'` : `'${requested}' (→ '${provider}')`;
      throw new Error(
        `--base-url does not apply to --provider ${label}: its endpoint is PINNED to ${pinned} in code, ` +
        'because its credential is only valid against that host.',
      );
    }
  }
  opts.workers = parseInt(opts.workers, 10);
  if (isNaN(opts.workers) || opts.workers < 1) throw new Error('--workers must be a positive integer.');
  return opts;
}

// [LAW:dataflow-not-control-flow] How an auth variant READS is one entry per variant, so the report
// never has to reach for a baseUrl the subscription variant does not carry.
const AUTH_LABEL = {
  'api-key': e => `api-key → ${e.baseUrl}`,
  oauth: e => `oauth (subscription) → ${e.baseUrl} — billed to plan quota, not per token`,
};

// The timing summary line, or its explicit failure — one value either way, so the report always
// carries a `timing:` line and a render bug reads as its own cause instead of a missing row.
function renderTimingLine(schedule, totalMs) {
  const { renderTimingBreakdown } = require('../src/schedule');
  try {
    return renderTimingBreakdown(schedule, totalMs).split('\n')[0].replace(/^_|_$/g, '');
  } catch (e) {
    return `unavailable (${e.message})`;
  }
}

// [LAW:effects-at-boundaries] Pure: render the report string from values. Highlights the one signal
// this tool exists for — explore-or-not, and whether exploration reached beyond the changed files.
function formatReport({ config, mode, files, result, sessions, repo, totalMs }) {
  const { renderCostLine } = require('../src/usage');
  const lines = [];
  lines.push('================ local-review report ================');
  lines.push(`config:   ${config.name}  (engine=${config.engine}, model=${config.model})`);
  lines.push(`endpoint: ${AUTH_LABEL[config.endpoint.credential.kind](config.endpoint)}`);
  lines.push(`mode:     ${mode}${mode === 'pr' ? `  (${files.length} changed file(s))` : ''}`);
  lines.push('');

  // [LAW:one-source-of-truth] Render read targets repo-relative so they compare directly against the
  // changed filenames (and so src/run.js never collides visually with src/engine/run.js).
  const changed = new Set(files.map(f => f.filename));
  sessions.forEach((s, i) => {
    const c = s.toolCounts;
    const counts = Object.keys(c).length ? Object.entries(c).map(([n, v]) => `${n}=${v}`).join(', ') : '(none)';
    const readsRel = s.reads.map(p => path.relative(repo, p));
    const beyond = readsRel.filter(r => !changed.has(r));
    lines.push(`--- engine session ${i + 1}/${sessions.length} ---`);
    lines.push(`  EXPLORED REPO: ${s.explored ? `YES (${s.exploreCalls} Read/Grep/Glob call(s))` : 'NO — reviewed the inline diff only'}`);
    lines.push(`  tool calls:    ${counts}`);
    if (readsRel.length) lines.push(`  files read:    ${readsRel.join(', ')}`);
    lines.push(`  beyond diff:   ${beyond.length ? beyond.join(', ') : 'nothing — exploration (if any) stayed within the changed files'}`);
    if (s.greps.length) lines.push(`  grep patterns: ${s.greps.join(' | ')}`);
    if (s.globs.length) lines.push(`  glob patterns: ${s.globs.join(' | ')}`);
    lines.push(`  transcript:    ${s.file}`);
  });
  lines.push('');

  lines.push(`findings (${result.findings.length}):`);
  for (const f of result.findings) {
    lines.push(`  • ${f.path}:${f.line}`);
    lines.push(`      ${(f.body || '').replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  lines.push('');
  lines.push('summary:');
  lines.push(`  ${(result.summary || '').replace(/\n/g, '\n  ')}`);
  lines.push('');

  // [LAW:one-source-of-truth] The action's OWN cost renderer, not a second rendering of the same
  // value — so a subscription run reads here exactly as it will read in the posted footer, and this
  // diagnostic cannot drift into disagreeing with production about what a run cost.
  const costLine = renderCostLine(result.usage, config);
  lines.push(costLine ? `usage: ${costLine.replace(/^_|_$/g, '')}` : 'usage: not reported');
  // [LAW:one-source-of-truth] The action's OWN timing renderer, same rationale as the cost line
  // above: the local breakdown cannot drift from what a production footer would say. The summary
  // line is what a terminal reader wants; the <details> table is footer furniture, dropped here.
  // [LAW:no-silent-failure] Same discipline as buildReviewFooter's boundary: a render failure is
  // printed as the line's explicit gap, naming the cause — never a vanished line, and never an
  // abort that costs the findings and session diagnostics this tool exists for.
  lines.push(`timing: ${renderTimingLine(result.schedule ?? null, totalMs)}`);
  lines.push('=====================================================');
  return lines.join('\n');
}

// The effectful helpers below lazily require their src deps, so importing this module never loads the
// engine stack — only main() (or a helper it calls) does, after the run boundary is established.
// [LAW:one-type-per-behavior] Both sources produce the SAME shape — an ordered ReviewConfig chain,
// secrets resolved — so main() drives runMultiScope identically whichever way the config arrived.
// --config goes through src/config.js loadConfig, the seam production CONFIG_FILE runs cross, so a
// file that works here works verbatim in the action (and fails here exactly as it would there).
// [LAW:one-source-of-truth]
function resolveConfigChain(opts) {
  if (opts.config) {
    const { loadConfig } = require('../src/config');
    return loadConfig(path.resolve(opts.config), opts.use, process.env);
  }
  // [LAW:one-source-of-truth] The per-provider input-key names are NOT restated here. This used to
  // spell out every provider's credential/model/base-url key by hand, and eval/run-case.js carried a
  // second copy of the same list that silently fell behind. Both now go through the one seam that
  // owns the mapping, so a new provider row reaches both the day it lands.
  const { resolveProviderConfig } = require('../src/provider');
  return [resolveProviderConfig({
    provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl, env: process.env,
  })];
}

function loadDiffFiles(opts) {
  const { parseUnifiedDiff, parseReviewableFiles } = require('../src/diff');
  const diffText = opts.diff
    ? fs.readFileSync(opts.diff, 'utf8')
    : execFileSync('git', ['-C', opts.repo, 'diff', ...opts.range.split(/\s+/).filter(Boolean)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { files: parsed, warnings } = parseUnifiedDiff(diffText);
  warnings.forEach(w => console.warn(w));
  // The same boundary production crosses in selectTransport. This script's whole value is that a local
  // run matches a production run for the same inputs, so it must not skip a boundary that changes which
  // files get reviewed. [LAW:single-enforcer]
  const { files, unreviewable } = parseReviewableFiles(parsed);
  unreviewable.forEach(u => console.warn(`Skipping ${u.filename} from the review: ${u.reason}.`));
  if (files.length === 0) {
    throw new Error(`No changed files in the diff (${opts.diff || `git diff ${opts.range}`}). Pick a range with changes, or use --mode repo.`);
  }
  return files;
}

function readSessions(transcriptDir) {
  if (!fs.existsSync(transcriptDir)) return [];
  return fs.readdirSync(transcriptDir)
    .filter(f => f.endsWith('.txt'))
    .map(f => path.join(transcriptDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
    .map(file => ({ file, ...summarizeSession(fs.readFileSync(file, 'utf8')) }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  // The local run's one clock, minted at the run boundary exactly as run.js mints its own — so the
  // reported total covers config resolution and diff parsing, time no spawn owns, the same way
  // production's total covers preflight and host I/O. [LAW:no-ambient-temporal-coupling]
  const startedAt = Date.now();

  // [LAW:no-ambient-temporal-coupling] main owns the ordering: create an isolated run dir and point
  // RUNNER_TEMP at it BEFORE the engine stack is required, so debug.js computes TRANSCRIPT_DIR against
  // this run's dir and readSessions sees exactly this run's transcripts. The effect is here, at the
  // boundary, never at module load. [LAW:effects-at-boundaries]
  const runTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-review-'));
  process.env.RUNNER_TEMP = runTemp;
  const { TRANSCRIPT_DIR } = require('../src/debug');
  const { runMultiScope, buildPrMaterial, buildRepoMaterial } = require('../src/multiscope');
  const { defaultEffortProfile } = require('../src/effort');
  const registry = require('../src/engine/registry');

  const repo = path.resolve(opts.repo);
  const chain = resolveConfigChain(opts);
  // The announce line below names the SELECTED config — all that exists before the run. The report is
  // attributed to configUsed, the config that actually produced the review after failover, exactly as
  // run.js attributes the posted footer. [LAW:one-source-of-truth]
  const config = chain[0];
  const files = opts.mode === 'pr' ? loadDiffFiles(opts) : [];
  const instructionsPath = path.join(__dirname, '..', 'review-agent', 'instructions.md');

  // [LAW:one-type-per-behavior] Pick the material by mode — the only thing PR and repo differ on,
  // exactly as run.js does — then drive the identical production engine. The local harness IS the
  // production path minus the GitHub sink.
  const material = opts.mode === 'pr'
    ? buildPrMaterial({ files, maxDiffChars: 0, reviewedRepoRoot: repo })
    : buildRepoMaterial({ scope: opts.scope, excludePatterns: [], reviewedRepoRoot: repo });

  process.stderr.write(`Running multi-scope ${opts.mode} review: ${config.name} (${config.model}) over ${opts.mode === 'pr' ? `${files.length} file(s)` : 'whole repo'}…\n`);
  const { review, configUsed } = await runMultiScope({
    // The --workers flag is this dev tool's one effort knob; it produces a profile with that scope
    // concurrency, spread over the default so it stays complete as the profile grows fields.
    chain, material, registry, instructionsPath,
    effort: { ...defaultEffortProfile(), scopeConcurrency: opts.workers },
    log: msg => process.stderr.write(`[local-review] ${msg}\n`),
    // [LAW:one-source-of-truth] The same start instant formatReport's total counts from, so the
    // live running totals and the report's figure share one clock.
    startedAt,
  });

  const report = formatReport({ config: configUsed, mode: opts.mode, files, result: review, sessions: readSessions(TRANSCRIPT_DIR), repo, totalMs: Date.now() - startedAt });
  process.stdout.write(`\n${report}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`local-review: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, formatReport, resolveConfigChain };
