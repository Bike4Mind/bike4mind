/**
 * What can make the credits glance read again, and how soon after the last read each may.
 *
 * Every reason is an event this window witnesses; there is no timer, so the number of reads is
 * bounded by what the user does. The gaps then cap the bursts those events come in: focus
 * flickers as windows are switched, and agent runs settle turns back to back.
 */
export type RefreshReason = 'mount' | 'turn' | 'focus' | 'open';

/** Minimum time since the last profile read before a reason may read again (ms). */
export const PROFILE_MIN_GAP_MS: Readonly<Record<RefreshReason, number>> = {
  mount: 0,
  turn: 15_000,
  open: 60_000,
  focus: 5 * 60_000,
};

/**
 * Minimum time between usage-history reads (ms), whatever the reason.
 *
 * The history is a month-long aggregation feeding a 7-day average, so one more turn barely moves
 * it; main also caches it for a minute (see UsageService).
 */
export const USAGE_MIN_GAP_MS = 5 * 60_000;

export function profileReadDue(reason: RefreshReason, lastReadAt: number | null, now: number): boolean {
  return lastReadAt === null || now - lastReadAt >= PROFILE_MIN_GAP_MS[reason];
}

export function usageReadDue(lastReadAt: number | null, now: number): boolean {
  return lastReadAt === null || now - lastReadAt >= USAGE_MIN_GAP_MS;
}
