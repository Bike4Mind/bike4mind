/** Default date window for the personal feedback rollup view. */

const DAY_MS = 24 * 60 * 60 * 1000;

export const FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS = 30;

let resolved: { from: string; to: string } | undefined;

/**
 * The default window, resolved once per app load and then reused verbatim.
 *
 * Stability is the whole point: the rollup query key carries `from`/`to`, so a default computed
 * fresh on each call would hand react-query a new key every time the route re-rendered and refetch
 * forever. The route's `validateSearch` fills the bounds with this, which is also what makes a bare
 * `/feedback/rollup` URL load instead of sitting disabled behind an `enabled` guard.
 */
export function defaultFeedbackRollupWindow(): { from: string; to: string } {
  if (!resolved) {
    const to = new Date();
    resolved = {
      from: new Date(to.getTime() - FEEDBACK_ROLLUP_DEFAULT_WINDOW_DAYS * DAY_MS).toISOString(),
      to: to.toISOString(),
    };
  }
  return resolved;
}
