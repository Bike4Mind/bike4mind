import { HOST_DEADLINE_GRACE_MS, TOOL_CALL_TIMEOUT_FRACTION } from '@bike4mind/agents';

/**
 * The REPL timeout ladder, in one place.
 *
 * Seven bounds nest around an LLM-authored `code_execute` run, innermost first:
 *
 *   tool HTTP < sub-LLM HTTP < tool dispatch < isolate script < host deadline < request abort < Lambda SIGKILL
 *      15s          18s            20s             25s             25.5s            55s             60s
 *
 * Each level exists so the one below it can produce a real, attributable error
 * instead of being swallowed by the one above. Invert any pair and the failure
 * is not an error but a WORSE error: a stalled article fetch that should cost
 * one observation instead takes the isolate (and every later `code_execute` in
 * the session), or takes the whole request and returns the caller no answer at
 * all. The original defect was exactly that - a 60s per-call cap sitting above
 * a 55s request abort, so neither REPL-level bound could ever fire.
 *
 * The literal rungs live here; the tool-dispatch and host-deadline rungs are
 * derived from the executor's own constants, which is why
 * `timeoutLadder.test.ts` imports both and asserts the ordering. Nothing in
 * the type system relates these numbers, so a test is the only thing that
 * notices when one moves.
 *
 * THE ORDERING IS A PROPERTY OF THE APPLIED BOUNDS, NOT THE CONSTANTS. The
 * dispatch bound a tool actually receives is `min(toolDispatchTimeoutMs(),
 * time left in the run)`, so it decays as the run proceeds: past ~7s of a 25s
 * script it sits under the 18s sub-LLM rung, and past ~10s under the 15s
 * tool-HTTP rung. Comparing the four constants above says nothing about that.
 * The rung a call is dispatched under is fixed by `toolMinBudgetMs`, which
 * refuses a spending tool rather than dispatching it inverted - see the
 * `executorOptions` comment at the `rlm-answer` session construction, and the
 * elapsed-time cases in `timeoutLadder.test.ts` that pin it.
 */

/**
 * Wall-clock budget for ONE tool call's HTTP work, shared across every request
 * that call makes (`getArticle` makes three sequentially, so they draw on one
 * signal rather than getting 15s each). Sized for a B4M API round trip.
 * `subAgentQuery` gets its own, larger rung below: it is the only tool that
 * waits on token generation rather than on a lookup.
 */
export const TOOL_HTTP_TIMEOUT_MS = 15_000;

/**
 * The sub-LLM provider call's own rung, and the output ceiling that has to fit
 * inside it. These two numbers are ONE decision and must move together.
 *
 * `subAgentQuery` is the only tool that spends money while it runs, so an
 * abort that fires mid-generation is the worst of both worlds: the provider
 * has already billed the tokens produced so far and the agent gets nothing
 * back. Giving it the generic 15s API-lookup bound against an 8000-token
 * ceiling guaranteed exactly that - 8000 tokens cannot stream in 15s at any
 * rate this model achieves, so a caller near the ceiling always paid for a
 * discarded answer.
 *
 * The deadline cannot simply be widened to fit 8000 tokens: it has to stay
 * under `toolDispatchTimeoutMs()` (20s), or the dispatcher abandons the await
 * first and the abort never produces an attributable error. So the ceiling
 * comes down to what this rung can actually deliver instead. Raising either
 * number without the other re-opens the defect.
 */
export const SUB_LLM_HTTP_TIMEOUT_MS = 18_000;
export const SUB_LLM_MAX_OUTPUT_TOKENS = 2_000;

/**
 * The output rate the pair above is sized against, in tokens per second.
 *
 * It exists so "the ceiling fits the deadline" is a checkable claim rather
 * than a magic number in a test. Deliberately a FLOOR and deliberately
 * pessimistic: the one model `subAgentQuery` may dispatch to (Claude Haiku
 * 4.5, the sole entry in that tool's pricing/allowlist table) sustains well
 * above this in practice, and the margin is what absorbs a slow first token
 * and a loaded provider. At 18s it admits a ceiling of ~2160 tokens, so the
 * 2000 above has roughly 8% of headroom and cannot drift far before the
 * ladder test objects.
 *
 * Add a slower model to that allowlist and this number has to come DOWN with
 * it, or the ceiling stops being deliverable for the slowest thing that can
 * be called.
 */
export const SUB_LLM_MIN_OUTPUT_TOKENS_PER_SECOND = 120;

/**
 * Per `code_execute` step, not per request. Deliberately far enough below
 * `HARD_TIMEOUT_MS` that a stalled step is reported to the agent as a
 * timed-out observation with budget left to answer.
 */
export const PER_CALL_REPL_TIMEOUT_MS = 25_000;

/**
 * Request-level abort. The frontend Lambda is configured for 60s in
 * `infra/web.ts` and AWS SIGKILLs past that, at which point `AbortSignal`
 * would never fire - so this sits below it with room to serialize a response.
 * Endpoint comments used to say "9 min", which was infra-incorrect. A
 * genuinely long-running agent run needs its own Lambda with a higher
 * `timeout`, or an async-job + polling shape.
 */
export const HARD_TIMEOUT_MS = 55_000;

/** The dispatch bound the isolate derives for a single host tool call. */
export const toolDispatchTimeoutMs = (scriptTimeoutMs = PER_CALL_REPL_TIMEOUT_MS): number =>
  Math.max(1, Math.floor(scriptTimeoutMs * TOOL_CALL_TIMEOUT_FRACTION));

/**
 * The bound a tool call dispatched `elapsedMs` into a run actually gets - the
 * static rung above, capped again by what remains of the script budget. This
 * is the number the ladder's ordering has to hold against; `toolDispatchTimeoutMs`
 * alone only describes a call made at t=0.
 */
export const appliedToolDispatchTimeoutMs = (elapsedMs: number, scriptTimeoutMs = PER_CALL_REPL_TIMEOUT_MS): number =>
  Math.min(toolDispatchTimeoutMs(scriptTimeoutMs), scriptTimeoutMs - elapsedMs);

/** The instant the host stops waiting and disposes the isolate. */
export const hostDeadlineMs = (scriptTimeoutMs = PER_CALL_REPL_TIMEOUT_MS): number =>
  scriptTimeoutMs + HOST_DEADLINE_GRACE_MS;
