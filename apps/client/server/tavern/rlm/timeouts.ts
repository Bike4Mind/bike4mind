import { HOST_DEADLINE_GRACE_MS, TOOL_CALL_TIMEOUT_FRACTION } from '@bike4mind/agents';

/**
 * The REPL timeout ladder, in one place.
 *
 * Six bounds nest around an LLM-authored `code_execute` run, innermost first:
 *
 *   tool HTTP  <  tool dispatch  <  isolate script  <  host deadline  <  request abort  <  Lambda SIGKILL
 *      15s            20s               25s               25.5s              55s               60s
 *
 * Each level exists so the one below it can produce a real, attributable error
 * instead of being swallowed by the one above. Invert any pair and the failure
 * is not an error but a WORSE error: a stalled article fetch that should cost
 * one observation instead takes the isolate (and every later `code_execute` in
 * the session), or takes the whole request and returns the caller no answer at
 * all. The original defect was exactly that - a 60s per-call cap sitting above
 * a 55s request abort, so neither REPL-level bound could ever fire.
 *
 * Only two rungs live here; the other two are derived from the executor's own
 * constants, which is why `timeoutLadder.test.ts` imports both and asserts the
 * ordering. Nothing in the type system relates these numbers, so a test is the
 * only thing that notices when one moves.
 */

/**
 * Wall-clock budget for ONE tool call's HTTP work, shared across every request
 * that call makes (`getArticle` makes three sequentially, so they draw on one
 * signal rather than getting 15s each; `subAgentQuery`'s provider call is
 * bounded by it too - it is the only one that spends money while it runs).
 */
export const TOOL_HTTP_TIMEOUT_MS = 15_000;

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

/** The instant the host stops waiting and disposes the isolate. */
export const hostDeadlineMs = (scriptTimeoutMs = PER_CALL_REPL_TIMEOUT_MS): number =>
  scriptTimeoutMs + HOST_DEADLINE_GRACE_MS;
