/** Default date window for the personal feedback rollup view. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** `to` is rounded up to this step, so it moves forward in coarse jumps rather than every millisecond. */
const WINDOW_END_STEP_MS = 5 * 60 * 1000;

export const FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS = 30;

let resolved: { from: string; to: string } | undefined;

/**
 * The default window: the last 30 days, ending at the next 5-minute boundary after now.
 *
 * Stability is the whole point: the rollup query key carries `from`/`to`, so a default computed
 * fresh to the millisecond on each call would hand react-query a new key every time the route
 * re-rendered and refetch forever. Within one 5-minute step this returns the same object, so the key
 * holds still; past it the window advances, so a report filed after the app loaded is counted the
 * next time the view renders. Rounding up (never down) keeps that report inside the window. The
 * route's `validateSearch` fills the bounds with this, which is also what makes a bare
 * `/feedback/rollup` URL load instead of sitting disabled behind an `enabled` guard.
 */
export function defaultFeedbackRollupWindow(now: number = Date.now()): { from: string; to: string } {
  const toMs = Math.ceil(now / WINDOW_END_STEP_MS) * WINDOW_END_STEP_MS;
  const to = new Date(toMs).toISOString();
  if (resolved?.to !== to) {
    resolved = {
      from: new Date(toMs - FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS * DAY_MS).toISOString(),
      to,
    };
  }
  return resolved;
}
