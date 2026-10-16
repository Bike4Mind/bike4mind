/**
 * Budget for an inline `wait: true` turn (pages/api/chat.ts), counted from the request's start.
 * Must stay below the server Lambda timeout (infra/web.ts, 60s) with room left for
 * WAIT_TURN_WIND_DOWN_MS and the settle + 504 that follow, or the Lambda dies first and the quest
 * is left `running` for questTimeoutSweep. chatContract's description quotes it as about 45s.
 */
export const WAIT_TURN_BUDGET_MS = 45_000;

/** How long an aborted turn gets to roll back its own credits and settle its quest. */
export const WAIT_TURN_WIND_DOWN_MS = 7_000;

/**
 * `aborted`: the deadline fired and the turn returned (or threw `error`) within the wind-down.
 * `stuck`: the deadline fired and the turn is still running after the wind-down.
 */
export type WaitTurnOutcome = { outcome: 'completed' } | { outcome: 'aborted'; error?: unknown } | { outcome: 'stuck' };

/**
 * Runs `turn` with a signal that aborts after `budgetMs`. An error thrown before the deadline
 * propagates unchanged; one thrown after it is the abort winding the turn down.
 */
export async function runWithDeadline(
  turn: (abortSignal: AbortSignal) => Promise<unknown>,
  { budgetMs, windDownMs }: { budgetMs: number; windDownMs: number }
): Promise<WaitTurnOutcome> {
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.max(0, budgetMs));
  let windDownTimer: ReturnType<typeof setTimeout> | undefined;
  const windDownExpired = new Promise<WaitTurnOutcome>(resolve => {
    controller.signal.addEventListener(
      'abort',
      () => {
        windDownTimer = setTimeout(() => resolve({ outcome: 'stuck' }), windDownMs);
      },
      { once: true }
    );
  });
  // Promise.resolve().then: a turn that throws synchronously still lands in the handler below.
  const turnSettled = Promise.resolve()
    .then(() => turn(controller.signal))
    .then(
      (): WaitTurnOutcome => (controller.signal.aborted ? { outcome: 'aborted' } : { outcome: 'completed' }),
      (error: unknown): WaitTurnOutcome => {
        if (!controller.signal.aborted) throw error;
        return { outcome: 'aborted', error };
      }
    );
  try {
    return await Promise.race([turnSettled, windDownExpired]);
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(windDownTimer);
  }
}
