import { PushNotificationEventSchema, type PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { isPushDeliveryConfigured } from '@bike4mind/server-utils/utils/pushDelivery';
import { NotificationEvents } from './eventBus';

export { isPushDeliveryConfigured };

/**
 * Publish-side helpers for `notification.push` (delivered by apps/workers/src/events/sendPush.ts).
 * Every publisher sits on a terminal seam of some other piece of work, so nothing here may throw.
 * Each publisher also checks isPushDeliveryConfigured() before any lookup it makes for the event, so a
 * deployment without APNs credentials spends no database read and no EventBridge call on push.
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

/** Validates and publishes; a failure is logged at warn and swallowed. A no-op while push is unconfigured. */
export async function publishPushNotification(
  event: PushNotificationEvent,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (!isPushDeliveryConfigured()) return;
  try {
    await NotificationEvents.Push.publish(PushNotificationEventSchema.parse(event));
  } catch (error) {
    logger.warn('[Push] failed to publish push notification', {
      category: event.category,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The Connection row fields that decide whether a socket means "the user is watching". */
export type WatchedConnectionRow = {
  source?: string;
  apiKeyId?: string | null;
  authExpiresAt?: Date | string | null;
};

export type ConnectionLookup = { findByUserId(userId: string): Promise<WatchedConnectionRow[]> };

/**
 * Whether a Connection row is a browser session that is still being kept alive. CLI sockets and
 * API-key sockets never render quest results, so they do not count. Nothing heartbeats a row mid-
 * session, so freshness comes from authExpiresAt: a web client moves it forward through
 * reauth_connection before its access token lapses, so a row past it is a socket nobody is keeping
 * alive (left for realtimeConnectionSweep to end). A row without it predates the field and is stale.
 */
export function isWatchingConnection(row: WatchedConnectionRow, now: Date = new Date()): boolean {
  if (row.source !== 'web' || row.apiKeyId) return false;
  if (!row.authExpiresAt) return false;
  return new Date(row.authExpiresAt).getTime() > now.getTime();
}

/**
 * Whether the user has a live browser connection (isWatchingConnection) among the rows
 * ClientMessageSender (b4m-core/utils/src/ws/ClientMessageSender.ts) finds. A user who is watching
 * sees the result live, so quest-shaped work (chat, image generation) skips the push.
 * Fails toward pushing: an unreadable connection table must not silence notifications.
 */
export async function hasLiveConnection(
  userId: string,
  connections: ConnectionLookup,
  logger: Pick<Logger, 'warn'>,
  now: Date = new Date()
): Promise<boolean> {
  try {
    return (await connections.findByUserId(userId)).some(row => isWatchingConnection(row, now));
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
