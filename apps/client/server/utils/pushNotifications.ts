import { PushNotificationEventSchema, type PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { NotificationEvents } from './eventBus';

/**
 * Publish-side helpers for `notification.push` (delivered by apps/workers/src/events/sendPush.ts).
 * Every publisher sits on a terminal seam of some other piece of work, so nothing here may throw.
 */

/**
 * The web app's notebook route (`/notebooks/$id`), which first-party clients also resolve. Absolute
 * when APP_URL is set; otherwise path-only, and sendPush resolves it against its own APP_URL.
 */
export function sessionDeepLink(sessionId: string): string {
  const path = `/notebooks/${encodeURIComponent(sessionId)}`;
  const base = (process.env.APP_URL ?? '').replace(/\/+$/, '');
  return base ? `${base}${path}` : path;
}

export function appRootDeepLink(): string {
  return (process.env.APP_URL ?? '').replace(/\/+$/, '') || '/';
}

/** Validates and publishes; a failure is logged at warn and swallowed. */
export async function publishPushNotification(
  event: PushNotificationEvent,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  try {
    await NotificationEvents.Push.publish(PushNotificationEventSchema.parse(event));
  } catch (error) {
    logger.warn('[Push] failed to publish push notification', {
      category: event.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type ConnectionLookup = { findByUserId(userId: string): Promise<unknown[]> };

/**
 * Whether the user has a live websocket row, read the way ClientMessageSender
 * (b4m-core/utils/src/ws/ClientMessageSender.ts) finds its recipients. A user who is connected sees
 * the result live, so quest-shaped work (chat, image generation) skips the push.
 * Fails toward pushing: an unreadable connection table must not silence notifications.
 */
export async function hasLiveConnection(
  userId: string,
  connections: ConnectionLookup,
  logger: Pick<Logger, 'warn'>
): Promise<boolean> {
  try {
    return (await connections.findByUserId(userId)).length > 0;
  } catch (error) {
    logger.warn('[Push] connection lookup failed; treating the user as offline', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** First `max` characters with an ellipsis, for titles and bodies built from user-named things. */
export function truncateForPush(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}
