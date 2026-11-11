import { User } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

/** At most one `lastActiveAt` write per user in this window (ms). */
export const USER_ACTIVITY_STAMP_INTERVAL_MS = 5 * 60 * 1000;

/** Whether a stored `lastActiveAt` is older than the throttle window, so a new action should write. */
export function needsActivityStamp(lastActiveAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastActiveAt) return true;
  return now.getTime() - new Date(lastActiveAt).getTime() >= USER_ACTIVITY_STAMP_INTERVAL_MS;
}

/**
 * Stamps `user.lastActiveAt` for an action the user took: a chat message, a completion, a content
 * write. Opening a tab, (re)connecting a socket and refreshing a token are not actions and must not
 * call this. The filter is the throttle, so concurrent callers in one window write once; the write
 * is fire-and-forget, and a failure is logged and never fails the action.
 */
export function recordUserActivity(userId: string, logger?: Pick<Logger, 'warn'>, now = new Date()): void {
  const staleBefore = new Date(now.getTime() - USER_ACTIVITY_STAMP_INTERVAL_MS);
  void User.updateOne(
    { _id: userId, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lte: staleBefore } }] },
    { $set: { lastActiveAt: now } },
    { timestamps: false }
  ).catch((error: unknown) => {
    logger?.warn('[userActivity] failed to record last active', { userId, error });
  });
}
