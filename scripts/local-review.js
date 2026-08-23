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
  const known = new Set(['provider', 'range', 'diff', 'repo', 'mode', 'scope', 'workers', 'model', 'base-url']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Option --${name} requires a value.`);
    opts[name === 'base-url' ? 'baseUrl' : name] = value;
  }
  if (opts.mode !== 'pr' && opts.mode !== 'repo') throw new Error(`--mode must be 'pr' or 'repo' (got '${opts.mode}').`);
  // [LAW:no-silent-failure] The subscription provider reads no base URL — accepting the flag and
  // quietly dropping it would leave the operator believing they had redirected the endpoint.
  if (opts.baseUrl && opts.provider === 'claude-subscription') {
    throw new Error("--base-url does not apply to --provider claude-subscription: a subscription token is only valid against Anthropic's own API.");
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

// [LAW:effects-at-boundaries] Pure: render the report string from values. Highlights the one signal
// this tool exists for — explore-or-not, and whether exploration reached beyond the changed files.
function formatReport({ config, mode, files, result, sessions, repo }) {
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

  if (result.usage) {
    const u = result.usage;
    const cost = u.cost && u.cost.available ? `$${u.cost.usd.toFixed(4)} est.` : `unavailable (${u.cost ? u.cost.reason : 'no-usage'})`;
    lines.push(`usage: in=${u.inputTokens} out=${u.outputTokens} cost=${cost}`);
  } else {
    lines.push('usage: not reported');
  }
  lines.push('=====================================================');
  return lines.join('\n');
}

// The effectful helpers below lazily require their src deps, so importing this module never loads the
// engine stack — only main() (or a helper it calls) does, after the run boundary is established.
function resolveConfig(opts) {
  const { synthesizeProviderConfig } = require('../src/provider');
  return synthesizeProviderConfig({
    provider: opts.provider,
    openaiApiKey: process.env.OPENAI_API_KEY, openaiModel: opts.model, openaiBaseUrl: opts.baseUrl,
    zaiApiKey: process.env.ZAI_API_KEY, zaiModel: opts.model, zaiBaseUrl: opts.baseUrl,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY, deepseekModel: opts.model, deepseekBaseUrl: opts.baseUrl,
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, claudeModel: opts.model,
  });
}

function loadDiffFiles(opts) {
  const { parseUnifiedDiff } = require('../src/diff');
  const diffText = opts.diff
    ? fs.readFileSync(opts.diff, 'utf8')
    : execFileSync('git', ['-C', opts.repo, 'diff', ...opts.range.split(/\s+/).filter(Boolean)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { files, warnings } = parseUnifiedDiff(diffText);
  warnings.forEach(w => console.warn(w));
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
  const config = resolveConfig(opts);
  const files = opts.mode === 'pr' ? loadDiffFiles(opts) : [];
  const instructionsPath = path.join(__dirname, '..', 'review-agent', 'instructions.md');

  // [LAW:one-type-per-behavior] Pick the material by mode — the only thing PR and repo differ on,
  // exactly as run.js does — then drive the identical production engine. The local harness IS the
  // production path minus the GitHub sink.
  const material = opts.mode === 'pr'
    ? buildPrMaterial({ files, maxDiffChars: 0, reviewedRepoRoot: repo })
    : buildRepoMaterial({ scope: opts.scope, excludePatterns: [], reviewedRepoRoot: repo });

  process.stderr.write(`Running multi-scope ${opts.mode} review: ${config.name} (${config.model}) over ${opts.mode === 'pr' ? `${files.length} file(s)` : 'whole repo'}…\n`);
  const { review } = await runMultiScope({
    // The --workers flag is this dev tool's one effort knob; it produces a profile with that scope
    // concurrency, spread over the default so it stays complete as the profile grows fields.
    chain: [config], material, registry, instructionsPath,
    effort: { ...defaultEffortProfile(), scopeConcurrency: opts.workers },
    log: msg => process.stderr.write(`[local-review] ${msg}\n`),
  });

  const report = formatReport({ config, mode: opts.mode, files, result: review, sessions: readSessions(TRANSCRIPT_DIR), repo });
  process.stdout.write(`\n${report}\n`);
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`local-review: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, formatReport };
