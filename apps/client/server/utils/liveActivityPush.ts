import { LiveActivityPushEventSchema, type LiveActivityPushEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { isPushDeliveryConfigured } from '@bike4mind/server-utils/utils/pushDelivery';
import { NotificationEvents } from '@bike4mind/server-utils/utils/eventBus';

/**
 * Publish-side helpers for `notification.liveActivity` (delivered by apps/workers/src/events/sendPush.ts).
 * Like the other push publishers, these sit on seams of unrelated work, so nothing here may throw.
 */

/**
 * Validates, stamps the publish time (APNs `timestamp`, see LiveActivityPushEventSchema) and publishes;
 * a failure is logged at warn and swallowed. A no-op while push is unconfigured.
 */
export async function publishLiveActivityUpdate(
  event: LiveActivityPushEvent,
  logger: Pick<Logger, 'warn'>,
  nowMs: number = Date.now()
): Promise<void> {
  if (!isPushDeliveryConfigured()) return;
  try {
    const stamped = { ...event, timestamp: event.timestamp ?? Math.floor(nowMs / 1000) };
    await NotificationEvents.LiveActivity.publish(LiveActivityPushEventSchema.parse(stamped));
  } catch (error) {
    logger.warn('[LiveActivity] failed to publish live activity update', {
      questId: event.questId,
      event: event.event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** APNs budgets live activity updates, and a lock screen gains nothing from more than a few a minute. */
export const LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;

/** Longest stage label either producer (chat turn, agent run) puts on the lock screen. */
export const LIVE_ACTIVITY_STAGE_LABEL_MAX = 60;

export type LiveActivityThrottle = {
  /**
   * Sends now when the quest's window is open; otherwise keeps only the latest state and flushes it
   * when the window reopens (unless it equals what was last sent). `end` always sends immediately and
   * discards anything pending. `immediate` sends an update now regardless of the window, for a state
   * the invocation may exit on (paused, awaiting approval) before a trailing flush could fire.
   */
  emit(event: LiveActivityPushEvent, options?: { immediate?: boolean }): Promise<void>;
  /**
   * Publishes every pending trailing frame now and cancels its timer. Await it before the invocation
   * ends: an unawaited timer is lost when the invocation exits, or fires stale in a thawed container.
   */
  flush(): Promise<void>;
};

/**
 * At most one `update` per quest per interval, with a trailing flush of the latest state. The state is
 * in-memory per instance, which is enough because the agent executor and quest processor each drive
 * one activity from a single long-lived invocation. Pass `publish` a function that never throws.
 */
export function createLiveActivityThrottle(
  publish: (event: LiveActivityPushEvent) => Promise<void>,
  intervalMs: number = LIVE_ACTIVITY_UPDATE_INTERVAL_MS
): LiveActivityThrottle {
  type QuestWindow = {
    lastSentAtMs: number;
    lastSentKey: string;
    pending?: LiveActivityPushEvent;
    timer?: ReturnType<typeof setTimeout>;
  };
  const windows = new Map<string, QuestWindow>();

  const keyOf = (event: LiveActivityPushEvent) => JSON.stringify([event.contentState, event.staleDate]);

  const sendUpdate = async (window: QuestWindow, event: LiveActivityPushEvent) => {
    window.lastSentAtMs = Date.now();
    window.lastSentKey = keyOf(event);
    await publish(event);
  };

  const clearPending = (window: QuestWindow) => {
    if (window.timer) clearTimeout(window.timer);
    window.timer = undefined;
    window.pending = undefined;
  };

  /** Clears the window's pending frame, returning it when it differs from what was last sent. */
  const takePending = (window: QuestWindow) => {
    const latest = window.pending;
    clearPending(window);
    return latest && keyOf(latest) !== window.lastSentKey ? latest : undefined;
  };

  return {
    async emit(event, options) {
      const existing = windows.get(event.questId);

      if (event.event === 'end') {
        if (existing) clearPending(existing);
        windows.delete(event.questId);
        await publish(event);
        return;
      }

      if (!existing) {
        const window: QuestWindow = { lastSentAtMs: 0, lastSentKey: '' };
        windows.set(event.questId, window);
        await sendUpdate(window, event);
        return;
      }

      if (options?.immediate) {
        clearPending(existing);
        await sendUpdate(existing, event);
        return;
      }

      const waitMs = existing.lastSentAtMs + intervalMs - Date.now();
      if (waitMs <= 0 && !existing.timer) {
        await sendUpdate(existing, event);
        return;
      }

      existing.pending = event;
      if (existing.timer) return;
      existing.timer = setTimeout(
        () => {
          const latest = takePending(existing);
          if (latest) void sendUpdate(existing, latest);
        },
        Math.max(waitMs, 0)
      );
      // A pending flush must not hold the process open once the run is over; flush() covers the exit.
      existing.timer.unref?.();
    },
    async flush() {
      const due = [...windows.values()].flatMap(window => {
        const latest = takePending(window);
        return latest ? [sendUpdate(window, latest)] : [];
      });
      await Promise.all(due);
    },
  };
}
