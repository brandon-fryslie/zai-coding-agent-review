'use strict';

const core = require('@actions/core');
const { remainingMs } = require('./deadline');

const TRANSIENT_RETRY_BUDGET_MS = 60 * 60 * 1000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

// [LAW:types-are-the-program] "Transient retryable error" is a type, not a flag bolted
// onto a generic Error. The raw 429/rate-limited and 529/overloaded signals are classified
// once, at the engine adapter boundary; the retry loop dispatches on the error's type,
// never a re-matched string. [LAW:one-type-per-behavior] Both share identical retry
// behavior, so they are one type — the cause survives only as a value (the message prefix).
// retryAfterMs carries the server-specified wait when the Retry-After header is echoed in
// CLI output; null means fall back to exponential backoff. [LAW:dataflow-not-control-flow]
class TransientError extends Error {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

// [LAW:types-are-the-program] "The model broke the collector protocol" is a distinct error type, not
// an anonymous Error indistinguishable from a code bug. It is thrown at the collector-read boundary
// (readCollectedReview) when a worker forgot finish_review (zero finishes) or wrote no records at all
// — the most common weak-model slip. [LAW:no-ambient-temporal-coupling] Recovery for this class is
// owned by the retry seam (retryTransientSpawn), not by WHERE the throw happens to originate: a fresh
// spawn very likely fixes a one-off slip, so this shares TransientError's short-horizon retry policy.
// [LAW:one-type-per-behavior] It is deliberately a SEPARATE type from TransientError — same retry
// policy, different meaning (a model protocol slip is not a flaky network) — so the two are never
// laundered into one. It carries no retryAfterMs: a model slip has no server-specified wait, so the
// retry loop falls to exponential backoff (err.retryAfterMs is undefined → the ?? default fires).
class ProtocolError extends Error {}

// [LAW:one-source-of-truth] The single place that names which errors a re-spawn can fix. TransientError
// and ProtocolError are distinct types that share ONE recovery policy (retry in place, short horizon);
// this predicate expresses that shared membership once, so retryTransientSpawn dispatches on the POLICY
// rather than a growing instanceof chain, and adding a future retryable class is a one-line change here.
function isRetryableSpawnError(err) {
  return err instanceof TransientError || err instanceof ProtocolError;
}

// Extract the server's Retry-After hint (seconds form) from CLI text output.
// Returns the exact value in milliseconds, or null if absent. No cap: the caller
// must honor the full server-specified window; TRANSIENT_BACKOFF_MAX_MS belongs
// on the exponential backoff path only. [LAW:one-source-of-truth]
function parseRetryAfterMs(text) {
  const match = /retry.?after[:\s]+(\d+)/i.exec(text);
  if (!match) return null;
  return parseInt(match[1], 10) * 1000;
}

// [LAW:one-source-of-truth]/[LAW:single-enforcer] The shared transient-failure vocabulary lives
// here, in exactly ONE place, and every engine adapter's classifyError consumes it — so a dropped
// socket is the SAME class of failure regardless of which engine hit it. Previously each adapter
// re-authored these regexes independently and they drifted: only claude-code recognized the network
// class, codex lacked 529, etc. — the same physical failure classified differently by engine.
// [FRAMING:representation] Three copies of one concept that can disagree is an under-constrained type.
//
// [LAW:one-type-per-behavior] A 429 rate-limit, a 529 overload, a dropped/terminated connection, and
// an endpoint 5xx are ONE class — the request got no definitive answer and a retry is safe — so they
// all construct the same TransientError; the cause survives only as the message prefix (a value).
// The network patterns are anchored — to the CLI's "API Error:" framing or to Node's socket error
// codes (ECONNRESET/…), never a bare English word — so ordinary review content (a diff mentioning
// "socket hang up" or "line 502") can't false-match; classifyError runs only on an already-failed
// spawn regardless.
const TRANSIENT_RATE_LIMIT = /\b429\b|rate.?limit/i;
const TRANSIENT_OVERLOADED = /\b529\b|overloaded/i;
const TRANSIENT_NETWORK = /api error:\s*(?:terminated|connection error|internal server error|socket hang up|fetch failed|5\d\d)\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEPIPE\b|\bEAI_AGAIN\b|\bENOTFOUND\b/i;

// Classify the shared transient signals from an engine's captured output. Returns a TransientError
// when the text carries one of the shared physical-failure signals, else null so the calling adapter
// can add its OWN engine-specific classes (codex's insufficient_quota) before falling through to the
// raw error. [LAW:dataflow-not-control-flow] The rate-limit branch attaches the Retry-After hint via
// the injected retryAfterFrom extractor: claude-code echoes the header so it passes parseRetryAfterMs;
// codex/opencode don't surface it in a parseable form, so they omit the extractor (default → null) and
// fall to exponential backoff — the one genuinely per-engine difference, expressed as a value not a
// forked copy of the pattern set.
function classifyTransient(err, text, retryAfterFrom = () => null) {
  if (TRANSIENT_RATE_LIMIT.test(text)) return new TransientError(`rate-limited: ${err.message}`, retryAfterFrom(text));
  if (TRANSIENT_OVERLOADED.test(text)) return new TransientError(`overloaded: ${err.message}`);
  if (TRANSIENT_NETWORK.test(text)) return new TransientError(`connection error: ${err.message}`);
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function transientBackoffMs(attempt) {
  const cap = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return cap / 2 + Math.random() * (cap / 2);
}

// [LAW:no-mode-explosion] Short-horizon attempts for spawn-level recovery: 1 initial + 2 retries.
// Matches produceReview's PER_CONFIG_LIMIT, but is a DIFFERENT axis (see retryTransientSpawn).
const TRANSIENT_SPAWN_ATTEMPTS = 3;

// The circuit breaker on the retry ladder. Every OTHER layer is already a counted value —
// retryTransientSpawn's 3 spawns, produceReview's 3 attempts per config — but the sweep that restarts
// chain[0] was unbounded, exiting only when the wall clock ran out. That is survivable for a blip and
// catastrophic for a WALL: a Claude subscription whose quota is spent answers every spawn in ~500ms
// with `"error":"rate_limit"`, which classifyTransient types as transient (correctly — from the text
// alone a spent quota and a 429 of backpressure are the same words). Run 32641456876 therefore burned
// the ENTIRE TIME_BUDGET_MINUTES on 138 spawns it could never have won, then blamed the wrong knob:
// the deadline kill overwrote the rate-limit cause with "raise TIME_BUDGET_MINUTES", so the remedy on
// screen would have doubled the waste rather than ending it. [FRAMING:representation]
//
// Bounding the sweeps is deliberately the GENERAL fix rather than typing the quota wall: recognizing
// it means matching a vendor's own error prose, which leaves us permanently one message revision
// behind, while a bound needs to recognize nothing at all — a hard wall we have never seen (a
// suspended account, a spent prepay balance) costs seconds instead of the budget.
// [LAW:single-enforcer] It bounds the EXISTING ladder rather than adding a second retry counter
// beside PER_CONFIG_LIMIT, which would be a rival owner of "when do we stop" and drift from it.
// Two sweeps keeps exactly one full chain restart — real value when a brief outage outlasts the
// first pass — while capping a single-config chain at 6 attempts, tens of seconds, not 25 minutes.
const MAX_CHAIN_SWEEPS = 2;

// [LAW:decomposition] Spawn-level transient recovery — a DIFFERENT axis from produceReview's config
// failover. produceReview walks a chain of CONFIGS with a global budget; this retries ONE flaky
// engine request in place, so a single blip in one of N concurrent scope workers is absorbed there
// instead of failing the whole scout->workers pass (which would re-run the scout + every sibling
// worker and discard their already-recorded findings — a failure probability that GROWS with N).
// [LAW:one-source-of-truth] It owns no new timing math: the backoff curve and Retry-After precedence
// are the SAME shared primitives produceReview uses (transientBackoffMs, err.retryAfterMs), so retry
// TIMING lives in exactly one place; only the short-horizon attempt policy is local here.
// [LAW:no-silent-failure] A non-retryable error surfaces immediately; a retryable one (TransientError
// or ProtocolError — see isRetryableSpawnError) that EXHAUSTS its attempts is rethrown as itself (never
// swallowed). The two exhausted types then diverge at produceReview by design: an exhausted Transient
// still hits config-level failover/budget, while an exhausted Protocol (not a TransientError) reds the
// run with its precise cause — a persistent model protocol slip is a broken engine, not a provider blip.
// onRetry is the injected progress effect; sleepFn is injectable so tests drive the retry path with no
// real waits. [LAW:effects-at-boundaries]
// `deadline` (epoch ms, null = no budget) clamps every retry sleep to the time remaining — the same
// clamp produceReview applies to its own budget's sleeps, applied here to the spawn-level axis. An
// uncapped server Retry-After near the deadline would otherwise sleep the run past its own budget
// and into the workflow's timeout-minutes kill, the exact empty-handed cancellation the budget
// exists to prevent. A wake-up at (or past) the deadline is harmless by construction: the next
// attempt's spawn is refused at runEngine's deadline gate and degrades scope-by-scope as designed.
// [LAW:single-enforcer] retry timing stays owned HERE — callers thread the deadline value, never a
// pre-clamped sleep of their own.
async function retryTransientSpawn(thunk, { limit = TRANSIENT_SPAWN_ATTEMPTS, sleepFn = sleep, onRetry = () => {}, deadline = null, now = Date.now } = {}) {
  // [LAW:no-silent-failure] A limit < 1 would run zero iterations and fall through to `throw lastErr`
  // with lastErr still undefined — an opaque `throw undefined` crash. Reject it loud with a diagnostic.
  // The destructuring default fires only on `undefined`, so an explicit 0/negative reaches here; a
  // nonsensical retry budget is a caller bug, surfaced — never silently clamped to hide it.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`retryTransientSpawn: limit must be a positive integer, got ${limit}`);
  }
  let lastErr;
  for (let attempt = 1; attempt <= limit; attempt++) {
    try {
      return await thunk();
    } catch (err) {
      if (!isRetryableSpawnError(err)) throw err; // not retryable-in-place: surface immediately
      lastErr = err;
      // [LAW:no-silent-failure] Exhausted: rethrow AS ITSELF, preserving the type. A ProtocolError that
      // survives every attempt reaches produceReview's `!instanceof TransientError` gate and reds the run
      // with its precise cause — a genuinely broken engine is not laundered into config-level failover.
      if (attempt === limit) throw lastErr;
      const delay = Math.min(err.retryAfterMs ?? transientBackoffMs(attempt), Math.max(0, remainingMs(deadline, now())));
      onRetry({ attempt, limit, delay, err });
      await sleepFn(delay);
    }
  }
  // [LAW:no-silent-failure] Unreachable given the validated limit >= 1 (the final iteration always
  // returns or throws); a loud invariant backstop so a future refactor that breaks that can never fall
  // through to an undefined return silently masquerading as a successful review.
  throw new Error('retryTransientSpawn: loop exited without returning (invariant violated)');
}

// [LAW:no-ambient-temporal-coupling] produceReview is the single explicit owner of all
// retry timing and failover policy. produceOnce makes one attempt with no timing knowledge.
// [LAW:dataflow-not-control-flow] The chain is policy data, not branching: the same loop
// body runs every iteration; the config value (not a code branch) determines what runs.
// [LAW:no-silent-failure] Non-transient errors surface immediately; exhaustion throws the
// last transient error rather than returning silently. [LAW:effects-at-boundaries]
// core.warning is the only effect here; all timing state is explicit local variables.
//
// produceOnce and sleepFn are injectable for testing — tests pass stubs that throw on demand
// and a no-op sleeper to avoid real waits. [LAW:effects-at-boundaries]
// buildPromptFor is (toolNames) => string; each engine gets the right MCP tool identifiers
// in its prompt. [LAW:types-are-the-program] A plain string bakes in chain[0]'s toolNames.
// Per-config retry limit: 3 total attempts (1 initial + 2 retries), honoring Retry-After.
// After 3 transient failures on one config: advance to next config IMMEDIATELY — different
// provider, waiting buys nothing. Chain exhausted → exponential backoff (cap 60s) by sweep
// count, restart from chain[0] — for MAX_CHAIN_SWEEPS sweeps, then surface the last transient.
// The budget still clamps every sleep, but it is no longer what ENDS the ladder: a wall that
// fails instantly can otherwise spend the whole budget without ever making progress.
// [LAW:effects-at-boundaries] budgetMs is injectable so tests can set a zero/tiny budget
// to cover the 'deadline exceeded mid-retry' throw path without real 60-min waits.
// [LAW:no-ambient-temporal-coupling] `now` is the injected clock, the SAME seam the multi-scope
// pass and the spawn-level retry clamp use — so a caller measuring its budget on a fake clock has
// this layer spend it on that same clock, never on ambient wall time.
async function produceReview(chain, buildPromptFor, anchors, produceOnce, sleepFn = sleep, budgetMs = TRANSIENT_RETRY_BUDGET_MS, now = Date.now) {
  // [LAW:no-silent-failure] An empty chain never assigns lastErr; throw undefined is opaque.
  if (!chain.length) throw new Error('produceReview: chain must not be empty');
  const deadline = now() + budgetMs;
  let totalAttempts = 0;
  let lastErr;
  const PER_CONFIG_LIMIT = 3;

  for (let sweep = 1; sweep <= MAX_CHAIN_SWEEPS; sweep++) {
    for (const config of chain) {
      for (let attempt = 1; attempt <= PER_CONFIG_LIMIT; attempt++) {
        totalAttempts++;
        try {
          const review = await produceOnce(config, buildPromptFor, anchors);
          return { review, configUsed: config, attempts: totalAttempts };
        } catch (err) {
          if (!(err instanceof TransientError)) throw err; // non-transient: surface immediately
          lastErr = err;
          const budgetLeft = Math.max(0, deadline - now());
          if (budgetLeft === 0) throw lastErr;

          if (attempt < PER_CONFIG_LIMIT) {
            // Retry same config: honor Retry-After or use exponential backoff.
            const hintOrBackoff = err.retryAfterMs ?? transientBackoffMs(attempt);
            const delay = Math.min(hintOrBackoff, budgetLeft);
            const minsLeft = Math.ceil(budgetLeft / 60_000);
            const src = err.retryAfterMs != null ? 'Retry-After' : 'backoff';
            core.warning(
              `Transient error on '${config.name}' (${config.engine}/${config.model}) attempt ${attempt}/${PER_CONFIG_LIMIT}: ${err.message}. ` +
              `Retrying in ${Math.round(delay / 1000)}s [${src}] (~${minsLeft}m budget left).`,
            );
            await sleepFn(delay);
          } else {
            // All per-config attempts exhausted: advance to next config immediately.
            core.warning(
              `Transient error on '${config.name}' (${config.engine}/${config.model}) — all ${PER_CONFIG_LIMIT} attempts exhausted: ${err.message}. ` +
              `Advancing to next config.`,
            );
          }
        }
      }
    }

    // [LAW:no-silent-failure] The ladder is spent — every config failed PER_CONFIG_LIMIT times on
    // every sweep — so the last transient IS the run's cause and surfaces as itself. Breaking HERE,
    // before the backoff, is what keeps that diagnosis: sleeping on into a budget that will not buy
    // another attempt is how the deadline kill used to fire last and overwrite the rate-limit cause
    // with a complaint about TIME_BUDGET_MINUTES. The final sweep also has no restart to wait for.
    if (sweep === MAX_CHAIN_SWEEPS) break;

    // All configs exhausted for this sweep. Back off before restarting chain[0].
    // Honor lastErr.retryAfterMs if the last failure carried a Retry-After hint —
    // the per-config path does the same; omitting it here would make the sweep
    // restart immediately when the provider said to wait. [LAW:one-source-of-truth]
    const budgetLeft = Math.max(0, deadline - now());
    if (budgetLeft === 0) throw lastErr;
    const hintOrBackoff = lastErr.retryAfterMs ?? transientBackoffMs(sweep);
    const delay = Math.min(hintOrBackoff, budgetLeft);
    const minsLeft = Math.ceil(budgetLeft / 60_000);
    const src = lastErr.retryAfterMs != null ? 'Retry-After' : 'backoff';
    core.warning(
      `All ${chain.length} config(s) exhausted (sweep ${sweep}). ` +
      `Restarting chain in ${Math.round(delay / 1000)}s [${src}] (~${minsLeft}m budget left).`,
    );
    await sleepFn(delay);
  }
  // [LAW:no-silent-failure] Every sweep is spent. lastErr is necessarily assigned — the only path
  // that reaches the loop's end is the catch that assigned it — so the breaker reports the provider's
  // own last word, never an opaque `throw undefined` and never a success-shaped empty review.
  throw lastErr;
}

// Build the review attribution footer appended to every submitted review.
// [LAW:one-source-of-truth] The footer is built once here from the ReviewConfig value;
// transport.js references it as a parameter, never reconstructs it.
function buildAttributionFooter(config) {
  const parts = [
    `config \`${config.name}\``,
    config.engine,
    config.model || '(default model)',
  ];
  if (config.reasoning) parts.push(`reasoning \`${config.reasoning}\``);
  return `_Reviewed by ${parts.join(' / ')}._`;
}

module.exports = {
  TRANSIENT_RETRY_BUDGET_MS,
  TRANSIENT_SPAWN_ATTEMPTS,
  MAX_CHAIN_SWEEPS,
  TransientError,
  ProtocolError,
  isRetryableSpawnError,
  parseRetryAfterMs,
  classifyTransient,
  sleep,
  transientBackoffMs,
  retryTransientSpawn,
  produceReview,
  buildAttributionFooter,
};
