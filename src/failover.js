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
// The two alternatives here catch two DIFFERENT real conditions, and conflating them is a known
// hazard rather than a harmless overlap. `\b429\b` is an HTTP 429 — genuine backpressure, clears in
// seconds, retrying is right. `rate.?limit` also matches the claude-code CLI's structured
// `"error":"rate_limit"` event, which is how a SPENT SUBSCRIPTION QUOTA arrives: a wall that stands
// until a fixed future reset ("You've hit your limit · resets 1pm (UTC)"), where retrying is
// provably futile. Same class here, opposite right answers.
//
// They are NOT separated at this seam, deliberately, and the reason is evidence rather than taste:
// run 32641456876 gives 135 samples of the wall and ZERO samples of a real 429 from this engine, so
// any predicate splitting them would be validated on one side only — the classic enumeration gap,
// shipped as a confident-looking check. Until a genuine 429 is captured, the safety lives one layer
// down in produceReview, whose ladder is bounded by COUNT and therefore needs to recognize nothing
// at all: the wall, a real 429 that never clears, and walls never yet seen (a suspended account, a
// spent prepay balance) all terminate on the same path. [LAW:no-mode-explosion]
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
// provider, waiting buys nothing. Chain exhausted → surface the last transient as the run's
// cause. The chain is walked ONCE (see the loop below on why there is no second sweep), so the
// ladder has TWO bounds and ends at whichever fires first: the COUNT, PER_CONFIG_LIMIT ×
// chain.length, and the CLOCK, the `budgetLeft === 0` throw below — which an uncapped server
// Retry-After can reach well before the count does, making it frequently the tighter of the two.
// The clock did not stop applying; a count bound simply exists now, where before the clock was the
// ONLY terminator. That is the whole bug: with nothing counting, a provider that fails instantly
// and permanently spent the entire budget without ever making progress, and was then blamed on it.
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

  // [LAW:one-type-per-behavior] There is deliberately NO outer "sweep the chain again" loop, and its
  // absence is the whole fix. Walking the chain a second time re-runs work already done: for the
  // one-config chain that is the default (`PROVIDER: auto`), sweep 2 is the SAME config, endpoint,
  // credential and prompt as sweep 1 — identical behavior, differing only in that the backoff curve
  // restarts. It was never a second KIND of attempt; it was a multiplier on PER_CONFIG_LIMIT wearing
  // a loop, and its only real content ("let more time pass before retrying") is exactly what the
  // per-config backoff below already does.
  //
  // [LAW:carrying-cost] That duplicate axis is what turned a spent subscription quota into a
  // 25-minute run: the ladder multiplied (3 spawn-level × 3 per-config × N sweeps) and nothing but
  // the wall clock ever stopped it, so the run lasted exactly as long as it was ALLOWED and the
  // attempt count was merely however many fit. Deleting the axis is what bounds the ladder — a cap
  // on it would have been the identical behavior with a knob left behind to tune forever.
  // [LAW:no-mode-explosion] the flag that is never added needs no owner and no deletion date.
  //
  // The index makes "last config" a POSITIONAL fact rather than object identity: a chain may
  // legitimately hold two references to equal configs, and `config === chain.at(-1)` would then
  // call the wrong rung final. [LAW:types-are-the-program]
  for (const [configIndex, config] of chain.entries()) {
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
          // All per-config attempts exhausted. [LAW:one-source-of-truth] The sentence names what
          // ACTUALLY happens next, read off the same fact the loop terminates on, rather than
          // asserting a fixed "Advancing…" that the last config falsifies one statement later. A
          // run whose whole purpose is an accurate diagnosis must not sign off with an inaccuracy.
          const isLastConfig = configIndex === chain.length - 1;
          core.warning(
            `Transient error on '${config.name}' (${config.engine}/${config.model}) — all ${PER_CONFIG_LIMIT} attempts exhausted: ${err.message}. ` +
            (isLastConfig
              ? `Chain spent (${chain.length} config(s) × ${PER_CONFIG_LIMIT} attempts); surfacing this error as the run's cause.`
              : 'Advancing to next config.'),
          );
        }
      }
    }
  }
  // [LAW:no-silent-failure] Every config is spent, so the last transient IS the run's cause and
  // surfaces as itself — the diagnosis the 25-minute deadline kill used to fire last and overwrite
  // with a complaint about TIME_BUDGET_MINUTES. lastErr is necessarily assigned: the only path that
  // reaches here is the catch that assigned it (a chain with zero configs is refused above), so this
  // can never be an opaque `throw undefined`, and never a success-shaped empty review.
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
