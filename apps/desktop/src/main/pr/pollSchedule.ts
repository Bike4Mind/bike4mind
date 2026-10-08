import type { PrState } from '@shared/pullRequest';

/**
 * How often a bound, open PR is read, in ms.
 *
 * The one on screen is what the user is watching, so it gets 30s while anything is still
 * moving (checks running, GitHub still computing mergeability) and 2 min once it has settled.
 * A conversation opened earlier this launch is read every 3 min / 10 min: its bar is a click
 * away and a stale answer there costs little. One nobody has opened since launch is read only
 * when an automation is armed on it, every 15 min - enough for auto-archive and auto-merge to
 * act within a coffee break, and at most four reads an hour per armed PR.
 *
 * Reads due on the same tick share one GraphQL query (see PrMonitor.readTogether). Measured on
 * GitHub: ten PRs in one query cost 1 point of the 5000/hour budget, 5 with auto-fix's review
 * data on all ten, against 10 points read one by one.
 */
export const POLL_MS = {
  onScreenActive: 30_000,
  onScreenSettled: 2 * 60_000,
  openedActive: 3 * 60_000,
  openedSettled: 10 * 60_000,
  unopenedArmed: 15 * 60_000,
  /** Failures double the wait from at least this, up to `maxBackoff`. */
  backoffFloor: 60_000,
  maxBackoff: 30 * 60_000,
  /** How long every read stops after GitHub says the rate limit is hit. */
  rateLimitPause: 15 * 60_000,
  /** The grid every timed read lands on. Every cadence above is a multiple of it. */
  tick: 15_000,
} as const;

/**
 * `ms` stretched to end on the next grid line. Reads that would have been seconds apart fire
 * on the same line and go out as one query; none is delayed by more than a tick.
 */
export function alignToTick(now: number, ms: number): number {
  return Math.ceil((now + ms) / POLL_MS.tick) * POLL_MS.tick - now;
}

export interface PollInput {
  /** The last state read, or undefined before the first read. */
  state: PrState | undefined;
  dismissed: boolean;
  onScreen: boolean;
  /** Opened in some window since launch. */
  opened: boolean;
  /** Any of auto-fix, auto-merge or auto-archive is on. */
  armed: boolean;
  /** Checks running, or mergeability still being computed. */
  active: boolean;
  /** Consecutive failed reads. */
  failures: number;
}

/** Milliseconds until the next read, or null for none at all. */
export function pollDelay(input: PollInput): number | null {
  if (input.state === 'MERGED' || input.state === 'CLOSED') return null;
  if (input.dismissed && !input.armed) return null;

  let base: number | null;
  if (input.onScreen && !input.dismissed) base = input.active ? POLL_MS.onScreenActive : POLL_MS.onScreenSettled;
  else if (input.opened) base = input.active ? POLL_MS.openedActive : POLL_MS.openedSettled;
  else base = input.armed ? POLL_MS.unopenedArmed : null;
  if (base === null) return null;

  if (input.failures <= 0) return base;
  const backoff = Math.max(base, POLL_MS.backoffFloor) * 2 ** Math.min(input.failures, 10);
  return Math.min(backoff, POLL_MS.maxBackoff);
}
