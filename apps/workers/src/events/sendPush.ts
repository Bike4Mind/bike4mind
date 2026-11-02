import type { EventBridgeEvent } from 'aws-lambda';
import {
  isPushCategoryEnabled,
  type PushNotificationCategory,
  type PushNotificationEvent,
  type PushNotificationPreferences,
} from '@bike4mind/common';
import {
  organizationRepository,
  pushTokenRepository,
  userRepository,
  type PushTokenEnvironment,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { withEventContext } from '@workers/utils/eventContext';
import { NotificationEvents } from '@server/utils/eventBus';
import { truncateForPush } from '@server/utils/pushNotifications';
import { createHttp2ApnsTransport, readApnsConfig, type ApnsTransport } from './sendPush.apns';

/**
 * `notification.push` consumer: delivers to the user's device tokens over APNs.
 *
 * Delivery rules, in order: the user must have device tokens; the category must not be switched off
 * in `preferences.pushNotifications`; the user's organization's `redactPushContent` swaps title and
 * body for category-generic copy. Publishers apply their own gates (e.g. chat only pushes when the
 * user has no live websocket) before the event exists.
 *
 * Dedupe is APNs collapse semantics, not a server-side ledger: every push carries apns-collapse-id
 * (the publisher's collapseId, else one derived from category + quest/session), so an EventBridge
 * redelivery or a second terminal site for the same run replaces the notification on the device
 * instead of stacking a duplicate.
 */

/** Responses meaning the token will never work again; the row is deleted. */
const PRUNE_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

// APNs caps apns-collapse-id at 64 bytes; ids here are ASCII.
const MAX_COLLAPSE_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 240;

export const REDACTED_PUSH_COPY: Record<PushNotificationCategory, { title: string; body: string }> = {
  agent_completed: { title: 'Agent finished', body: 'An agent run has finished.' },
  agent_failed: { title: 'Agent run failed', body: 'An agent run could not finish.' },
  approval_needed: { title: 'Approval needed', body: 'An agent is waiting for your confirmation.' },
  chat_completed: { title: 'Reply ready', body: 'A new reply is ready.' },
  generation_ready: { title: 'Generation ready', body: 'Your generated media is ready.' },
  agent_message: { title: 'New message', body: 'An agent sent you a message.' },
};

export type PushRecipient = {
  preferences: PushNotificationPreferences | null | undefined;
  redactContent: boolean;
};

export type SendPushDeps = {
  tokens: {
    findByUser(
      userId: string,
      kind: 'device'
    ): Promise<ReadonlyArray<{ token: string; environment: PushTokenEnvironment }>>;
    removeByToken(token: string): Promise<boolean>;
  };
  loadRecipient(userId: string): Promise<PushRecipient | null>;
  transport: ApnsTransport;
  topic: string;
  /** Resolves a path-only deepLink (see sessionDeepLink in apps/client/server/utils/pushNotifications.ts). */
  appUrl?: string;
};

export type PushDeliveryResult =
  | { status: 'skipped'; reason: 'no_tokens' | 'no_recipient' | 'category_disabled' }
  | { status: 'sent'; delivered: number; pruned: number; failed: number };

export async function deliverPush(
  event: PushNotificationEvent,
  deps: SendPushDeps,
  logger: Pick<Logger, 'info' | 'warn'>
): Promise<PushDeliveryResult> {
  const tokens = await deps.tokens.findByUser(event.userId, 'device');
  if (tokens.length === 0) {
    logger.info('[Push] user has no device tokens; nothing to send', { category: event.category });
    return { status: 'skipped', reason: 'no_tokens' };
  }

  const recipient = await deps.loadRecipient(event.userId);
  if (!recipient) {
    logger.warn('[Push] recipient user not found; dropping', { category: event.category });
    return { status: 'skipped', reason: 'no_recipient' };
  }
  if (!isPushCategoryEnabled(recipient.preferences, event.category)) {
    logger.info('[Push] category disabled by user preference', { category: event.category });
    return { status: 'skipped', reason: 'category_disabled' };
  }

  const headers = {
    'apns-topic': deps.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-collapse-id': collapseIdFor(event),
  };
  const payload = JSON.stringify(buildPayload(event, recipient.redactContent, deps.appUrl));

  let delivered = 0;
  let pruned = 0;
  let failed = 0;
  let retryable = 0;
  await Promise.all(
    tokens.map(async ({ token, environment }) => {
      try {
        const response = await deps.transport.send({ environment, deviceToken: token, headers, payload });
        if (response.status === 200) {
          delivered++;
          return;
        }
        failed++;
        if (response.status === 410 || (response.reason && PRUNE_REASONS.has(response.reason))) {
          if (await deps.tokens.removeByToken(token)) pruned++;
          return;
        }
        if (response.status === 429 || response.status >= 500) retryable++;
        logger.warn('[Push] APNs rejected the notification', {
          status: response.status,
          reason: response.reason,
          environment,
        });
      } catch (error) {
        failed++;
        retryable++;
        logger.warn('[Push] APNs request failed', {
          environment,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );

  logger.info('[Push] delivery finished', { category: event.category, delivered, pruned, failed });
  // Retry (and finally dead-letter) only when nothing landed and every failure may be transient. A
  // partial success is not retried: collapse-id would absorb the repeat, but APNs would still bill the
  // quota and the user's other devices would re-alert.
  if (delivered === 0 && retryable > 0 && retryable === failed) {
    throw new Error(`APNs delivery failed transiently for all ${failed} device(s)`);
  }
  return { status: 'sent', delivered, pruned, failed };
}

function collapseIdFor(event: PushNotificationEvent): string {
  const id = event.collapseId ?? `${event.category}:${event.questId ?? event.sessionId ?? event.userId}`;
  return id.slice(0, MAX_COLLAPSE_ID_LENGTH);
}

function buildPayload(event: PushNotificationEvent, redact: boolean, appUrl: string | undefined) {
  const copy = redact ? REDACTED_PUSH_COPY[event.category] : event;
  return {
    aps: {
      alert: {
        title: truncateForPush(copy.title, MAX_TITLE_LENGTH),
        body: truncateForPush(copy.body, MAX_BODY_LENGTH),
      },
      sound: 'default',
      ...(event.sessionId && { 'thread-id': event.sessionId }),
    },
    category: event.category,
    deepLink: resolveDeepLink(event.deepLink, appUrl),
    ...(event.questId && { questId: event.questId }),
    ...(event.sessionId && { sessionId: event.sessionId }),
  };
}

function resolveDeepLink(deepLink: string, appUrl: string | undefined): string {
  if (!deepLink.startsWith('/') || !appUrl) return deepLink;
  return `${appUrl.replace(/\/+$/, '')}${deepLink}`;
}

/** The user's opt-outs plus their active organization's redaction setting. */
export async function loadPushRecipient(userId: string): Promise<PushRecipient | null> {
  const user = await userRepository.findById(userId);
  if (!user) return null;
  const organization = user.organizationId ? await organizationRepository.findById(user.organizationId) : null;
  return {
    preferences: user.preferences?.pushNotifications,
    redactContent: organization?.redactPushContent === true,
  };
}

const handleWithContext = withEventContext(async (event, logger) => {
  const payload = NotificationEvents.Push.schema.parse(event.properties);
  logger.updateMetadata({ handler: 'sendPush', userId: payload.userId, category: payload.category });

  const config = readApnsConfig();
  if (!config) return;
  const transport = createHttp2ApnsTransport(config);
  try {
    await deliverPush(
      payload,
      {
        tokens: pushTokenRepository,
        loadRecipient: loadPushRecipient,
        transport,
        topic: config.topic,
        appUrl: process.env.APP_URL,
      },
      logger
    );
  } finally {
    transport.close();
  }
});

/**
 * Checked before withEventContext so an unconfigured deployment (preview, self-host) consumes the event
 * without opening a database connection.
 */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  if (!readApnsConfig()) {
    new Logger({ metadata: { handler: 'sendPush' } }).info('[Push] APNs is not configured; skipping');
    return;
  }
  await handleWithContext(event);
};
