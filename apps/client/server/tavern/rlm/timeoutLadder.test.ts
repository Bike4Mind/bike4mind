import { describe, it, expect } from 'vitest';
import { WAKE_PER_CALL_REPL_TIMEOUT_MS } from '@bike4mind/agents';
import {
  HARD_TIMEOUT_MS,
  PER_CALL_REPL_TIMEOUT_MS,
  SUB_LLM_HTTP_TIMEOUT_MS,
  SUB_LLM_MAX_OUTPUT_TOKENS,
  SUB_LLM_MIN_OUTPUT_TOKENS_PER_SECOND,
  TOOL_HTTP_TIMEOUT_MS,
  appliedToolDispatchTimeoutMs,
  hostDeadlineMs,
  toolDispatchTimeoutMs,
} from './timeouts';

/**
 * The ladder spans two packages, related by nothing the type system can see -
 * and it gains a constant whenever a rung does, so the count is not worth
 * writing down. Any single edit can invert the ordering, and the symptom is
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
   *
   * The rate compared against is the exported floor, not a literal, so the
   * number the assertion rests on is sourced where it is defined instead of
   * sitting unexplained in a test.
   */
  it('keeps the sub-LLM output ceiling deliverable inside its own rung', () => {
    const requiredTokensPerSecond = SUB_LLM_MAX_OUTPUT_TOKENS / (SUB_LLM_HTTP_TIMEOUT_MS / 1000);
    expect(requiredTokensPerSecond).toBeLessThanOrEqual(SUB_LLM_MIN_OUTPUT_TOKENS_PER_SECOND);
  });

  /**
   * The floor itself is the load-bearing half of that assertion: raise it and
   * any ceiling passes. Pinned as a range so a well-meaning edit that makes
   * the previous test green by loosening the rate has to argue with this one.
   */
  it('holds the output-rate floor to something a provider actually delivers', () => {
    expect(SUB_LLM_MIN_OUTPUT_TOKENS_PER_SECOND).toBeGreaterThanOrEqual(60);
    expect(SUB_LLM_MIN_OUTPUT_TOKENS_PER_SECOND).toBeLessThanOrEqual(150);
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

  /**
   * Every assertion above compares CONSTANTS, which is a statement about a
   * tool call made at t=0 and about nothing else. The bound a call actually
   * gets is capped again by what remains of the script budget, so it decays
   * across a run and crosses under the inner rungs partway through - the run
   * shape that reaches it ("two searches, then a sub-agent call") is ordinary,
   * not adversarial.
   *
   * These cases exist because the constant-only tests cannot fail on that:
   * the first pins WHEN the inversion begins, so the crossing point is a
   * number someone has to change deliberately, and the second pins the
   * resolution - `subAgentQuery` carries a `toolMinBudgetMs` floor equal to
   * its own rung, so it is refused rather than dispatched inverted.
   */
  it('inverts the sub-LLM rung once enough of the run is spent', () => {
    expect(appliedToolDispatchTimeoutMs(0)).toBe(toolDispatchTimeoutMs());
    // 25_000 - 18_000: the last instant a sub-LLM call still gets its rung.
    expect(appliedToolDispatchTimeoutMs(7_000)).toBe(SUB_LLM_HTTP_TIMEOUT_MS);
    expect(appliedToolDispatchTimeoutMs(7_001)).toBeLessThan(SUB_LLM_HTTP_TIMEOUT_MS);
    // And the tool-HTTP rung goes three seconds later.
    expect(appliedToolDispatchTimeoutMs(10_000)).toBe(TOOL_HTTP_TIMEOUT_MS);
    expect(appliedToolDispatchTimeoutMs(10_001)).toBeLessThan(TOOL_HTTP_TIMEOUT_MS);
  });

  /**
   * The wake path picks its own script cap in `@bike4mind/agents`, which
   * cannot import this module - the dependency only runs the other way. So
   * the rung is a literal in both places, and this is the assertion that
   * makes them one decision instead of two that happen to agree today.
   */
  it('gives the wake path the same per-step rung as the HTTP route', () => {
    expect(WAKE_PER_CALL_REPL_TIMEOUT_MS).toBe(PER_CALL_REPL_TIMEOUT_MS);
  });

  /**
   * The floor the route hands the executor as
   * `toolMinBudgetMs.subAgentQuery`, checked against the applied bound rather
   * than described. Refusing exactly when the rung would invert is what makes
   * the two mutually exclusive: every dispatch that survives the floor runs
   * under a bound at or above the tool's own deadline, so its abort always
   * fires before the dispatcher stops waiting. `IsolatedVmExecutor.test.ts`
   * pins that the executor actually refuses; this pins that the number it is
   * given is the right one.
   */
  it('leaves a usable window in which a sub-LLM call can still be made', () => {
    // A floor is only half a fix. Set it against a rung the run cannot
    // actually afford and every call is refused - the tool is dead rather
    // than safe, and nothing else in this file would notice.
    const windowMs = PER_CALL_REPL_TIMEOUT_MS - SUB_LLM_HTTP_TIMEOUT_MS;
    expect(appliedToolDispatchTimeoutMs(0)).toBeGreaterThanOrEqual(SUB_LLM_HTTP_TIMEOUT_MS);
    expect(appliedToolDispatchTimeoutMs(windowMs)).toBeGreaterThanOrEqual(SUB_LLM_HTTP_TIMEOUT_MS);
    // And wide enough that the ordinary shape - a couple of sub-second
    // searches, then a sub-agent call - still clears it.
    expect(windowMs).toBeGreaterThanOrEqual(5_000);
  });
});
