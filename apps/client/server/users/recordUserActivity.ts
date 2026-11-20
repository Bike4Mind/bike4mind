import { User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/** At most one `lastActiveAt` write per user in this window (ms). */
export const USER_ACTIVITY_STAMP_INTERVAL_MS = 5 * 60 * 1000;

/** Bounds the per-container memory of recent stamps; past it the memory resets, costing one write each. */
const MAX_REMEMBERED_STAMPS = 10_000;

// userId -> ms of the last stamp this container sent. Lets a caller that holds only a userId (the
// websocket actions) skip the round trip the way the middleware does with req.user.lastActiveAt.
const recentStamps = new Map<string, number>();

/** Whether a stored `lastActiveAt` is older than the throttle window, so a new action should write. */
export function needsActivityStamp(lastActiveAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastActiveAt) return true;
  return now.getTime() - new Date(lastActiveAt).getTime() >= USER_ACTIVITY_STAMP_INTERVAL_MS;
}

/**
 * Stamps `user.lastActiveAt` for an action the user took: a chat message, a completion, a content
 * write. Opening a tab, (re)connecting a socket and refreshing a token are not actions and must not
 * call this. The update filter is the throttle and the guard: concurrent callers in one window write
 * once, and the system user and accounts pending deletion never match. A stamp this container sent
 * inside the window skips the write entirely. Fire-and-forget: a failure is logged and never fails the
 * action.
 */
export function recordUserActivity(userId: string, logger?: Pick<Logger, 'warn'>, now = new Date()): void {
  const lastSent = recentStamps.get(userId);
  if (lastSent !== undefined && !needsActivityStamp(new Date(lastSent), now)) return;
  if (recentStamps.size >= MAX_REMEMBERED_STAMPS) recentStamps.clear();
  recentStamps.set(userId, now.getTime());

  const staleBefore = new Date(now.getTime() - USER_ACTIVITY_STAMP_INTERVAL_MS);
  void User.updateOne(
    {
      _id: userId,
      isSystem: { $ne: true },
      deletion: null,
      $or: [{ lastActiveAt: null }, { lastActiveAt: { $lte: staleBefore } }],
    },
    { $set: { lastActiveAt: now } },
    { timestamps: false }
  ).catch((error: unknown) => {
    // Forget the stamp so the next action retries instead of waiting out the window.
    recentStamps.delete(userId);
    logger?.warn('[userActivity] failed to record last active', { userId, error });
  });
}

/** Test seam: forget every remembered stamp. */
export function resetRecentActivityStamps(): void {
  recentStamps.clear();
}
