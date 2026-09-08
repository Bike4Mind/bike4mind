import { describe, it, expect } from 'vitest';
import {
  HARD_TIMEOUT_MS,
  PER_CALL_REPL_TIMEOUT_MS,
  SUB_LLM_HTTP_TIMEOUT_MS,
  SUB_LLM_MAX_OUTPUT_TOKENS,
  TOOL_HTTP_TIMEOUT_MS,
  hostDeadlineMs,
  toolDispatchTimeoutMs,
} from './timeouts';

/**
 * The ladder is six constants across two packages, related by nothing the type
 * system can see. Any single edit can invert the ordering, and the symptom is
 * not a failure but a WORSE failure: a step that should have timed out as one
 * observation instead takes the isolate - and every later `code_execute` in
 * the session - or takes the whole request and returns no answer at all.
 *
 * That is why the ordering is asserted rather than only described.
 */
describe('the REPL timeout ladder', () => {
  it('orders every rung innermost-first', () => {
    expect(TOOL_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(SUB_LLM_HTTP_TIMEOUT_MS);
    expect(SUB_LLM_HTTP_TIMEOUT_MS).toBeLessThan(toolDispatchTimeoutMs());
    expect(toolDispatchTimeoutMs()).toBeLessThan(PER_CALL_REPL_TIMEOUT_MS);
    expect(PER_CALL_REPL_TIMEOUT_MS).toBeLessThan(hostDeadlineMs());
    expect(hostDeadlineMs()).toBeLessThan(HARD_TIMEOUT_MS);
  });

  /**
   * The rung most easily lost. The original defect was exactly this one: a 60s
   * per-call cap against a 55s request abort, so neither REPL-level bound
   * could ever fire and one stalled step cost the caller the whole request.
   */
  it('leaves the request room to answer after a step has timed out', () => {
    expect(HARD_TIMEOUT_MS - hostDeadlineMs()).toBeGreaterThanOrEqual(20_000);
  });

  /**
   * The sub-LLM rung and its output ceiling are one decision: a request at the
   * ceiling has to be able to stream inside the deadline. Asserted as a rate
   * because that is the relationship that was violated - an 8000-token
   * ceiling against a 15s bound needs ~533 tok/s, which no model here does,
   * so every request near the ceiling was billed and then discarded.
   */
  it('keeps the sub-LLM output ceiling deliverable inside its own rung', () => {
    const requiredTokensPerSecond = SUB_LLM_MAX_OUTPUT_TOKENS / (SUB_LLM_HTTP_TIMEOUT_MS / 1000);
    expect(requiredTokensPerSecond).toBeLessThanOrEqual(150);
  });

  /**
   * Lambda SIGKILLs the frontend function at 60s, past which `AbortSignal`
   * never fires - so the request cap sits below it with room to serialize.
   */
  it('keeps the request cap under the Lambda ceiling', () => {
    expect(HARD_TIMEOUT_MS).toBeLessThanOrEqual(55_000);
  });

  /**
   * The derived rungs must hold their place at any script cap, not just the
   * one the route happens to use today - the wake path picks its own.
   */
  it('holds the derived ordering at every script cap', () => {
    for (const scriptMs of [10, 200, 1_000, 25_000, 30_000]) {
      expect(toolDispatchTimeoutMs(scriptMs)).toBeGreaterThan(0);
      expect(toolDispatchTimeoutMs(scriptMs)).toBeLessThan(scriptMs);
      expect(scriptMs).toBeLessThan(hostDeadlineMs(scriptMs));
    }
  });
});
