/**
 * Per-iteration Lambda-deadline guard for the agent executor's iteration loop.
 *
 * Kept in its own module so the timer arithmetic and abort-signal disambiguation can be
 * unit-tested without dragging in the executor's Mongo/AWS/SST deps.
 */

export type IterationDeadlineOutcome<T> = { kind: 'result'; result: T } | { kind: 'handed-off' };

export interface IterationDeadlineGuardParams<T> {
  /** Lambda's remaining execution budget right now (`context.getRemainingTimeInMillis()`). */
  remainingMs: number;
  /** Buffer subtracted from `remainingMs` before arming the abort timer. */
  timeoutBufferMs: number;
  /** Runs one iteration, given the signal to pass through as the LLM call's abort signal. */
  runIteration: (signal: AbortSignal) => Promise<T>;
}

export interface IterationDeadlineGuardEffects {
  /** Checkpoints the run and hands it to a continuation Lambda. */
  selfDispatchContinuation: () => Promise<void>;
}

/**
 * Runs one iteration with an abort timer armed at `remainingMs - timeoutBufferMs`, so a call
 * that would otherwise be hard-killed mid-flight aborts cleanly instead and the run can hand
 * off to a continuation Lambda (#3223).
 *
 * A deadline abort only ever throws out of `runIteration` when it lands during the LLM call -
 * a tool-phase abort is absorbed by ReActAgent's `runToolBatchAbortTolerant`, which returns
 * partial results instead of throwing, so that case surfaces as an ordinary `'result'` here and
 * the caller's own between-iteration watchdog picks up the handoff on its next pass. Either way
 * is the same "out of time" condition, so both resolve through the same continuation path
 * rather than one of them failing the run outright.
 *
 * A non-deadline error (a real iteration failure) is rethrown as-is - only the abort this timer
 * itself fired is treated as a handoff.
 */
export async function runIterationWithDeadlineGuard<T>(
  params: IterationDeadlineGuardParams<T>,
  effects: IterationDeadlineGuardEffects
): Promise<IterationDeadlineOutcome<T>> {
  const controller = new AbortController();
  const remainingAfterBuffer = Math.max(0, params.remainingMs - params.timeoutBufferMs);
  const timer = setTimeout(() => controller.abort(), remainingAfterBuffer);
  timer.unref?.();

  try {
    const result = await params.runIteration(controller.signal);
    return { kind: 'result', result };
  } catch (err) {
    if (controller.signal.aborted) {
      await effects.selfDispatchContinuation();
      return { kind: 'handed-off' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
