/**
 * Helpers for converting one or more `NotifyResult`s from GitHubSlackNotifier
 * into the `GitHubHandlerResult` shape consumed by the queue handler.
 *
 * Centralized so every event handler reports notification failures the same
 * way: delivery failures must surface as Failed, not Skipped.
 */

import { NotifyResult } from '@bike4mind/slack';
import { GitHubHandlerResult } from '../types';

// Factory rather than a shared const - returns fresh arrays so a future `.push()`
// on a caller's reference can't bleed into other invocations.
export function emptyNotifyResult(): NotifyResult {
  return { notifiedUserIds: [], failedNotifications: [] };
}

export function mergeNotifyResults(...results: NotifyResult[]): NotifyResult {
  const merged: NotifyResult = {
    notifiedUserIds: [],
    failedNotifications: [],
  };

  for (const r of results) {
    merged.notifiedUserIds.push(...r.notifiedUserIds);
    merged.failedNotifications.push(...r.failedNotifications);
    if (r.dispatchError) {
      merged.dispatchError = merged.dispatchError ? `${merged.dispatchError}; ${r.dispatchError}` : r.dispatchError;
    }
  }

  return merged;
}

export function toHandlerResult(result: NotifyResult): GitHubHandlerResult {
  return {
    notifiedUserIds: result.notifiedUserIds,
    ...(result.failedNotifications.length > 0 && { failedNotifications: result.failedNotifications }),
    ...(result.dispatchError && { notificationDispatchError: result.dispatchError }),
  };
}
