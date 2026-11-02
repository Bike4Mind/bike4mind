import type { EventBridgeEvent } from 'aws-lambda';
import {
  isPushCategoryEnabled,
  type LiveActivityPushEvent,
  type PushNotificationCategory,
  type PushNotificationEvent,
  type PushNotificationPreferences,
} from '@bike4mind/common';
import {
  authSessionRepository,
  organizationRepository,
  pushTokenRepository,
  userRepository,
  type PushTokenEnvironment,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { withEventContext } from '@workers/utils/eventContext';
import { NotificationEvents } from '@server/utils/eventBus';
import { truncateForPush } from '@server/utils/pushNotifications';
import {
  apnsSigningKeyError,
  createHttp2ApnsTransport,
  readApnsConfig,
  type ApnsConfig,
  type ApnsTransport,
} from './sendPush.apns';

/**
 * `notification.push` consumer: delivers to the user's device tokens over APNs.
 *
 * Delivery rules, in order: the user must have device tokens; the category must not be switched off
 * in `preferences.pushNotifications`; the user's active organization's `redactPushContent` swaps title and
 * body for category-generic copy. Publishers apply their own gates (e.g. chat only pushes when the
 * user has no live websocket) before the event exists.
 *
 * Dedupe is APNs collapse semantics, not a server-side ledger: every push carries apns-collapse-id
 * (the publisher's collapseId, else one derived from category + quest/session), so an EventBridge
 * redelivery or a second terminal site for the same run replaces the notification on the device
 * instead of stacking a duplicate.
 *
 * The same Lambda also consumes `notification.liveActivity` (see deliverLiveActivityPush), routed on
 * the event's detail-type.
 */

/**
 * Responses meaning the token will never work again; the row is deleted. BadDeviceToken is not one:
 * APNs also returns it for a valid token sent to the wrong gateway (a sandbox token on production or
 * the reverse), so it is logged with the stored environment and the row is kept.
 */
const isUnregistered = (response: { status: number; reason?: string }) =>
  response.status === 410 || response.reason === 'Unregistered';

/**
 * Rejections caused by this server's APNs configuration rather than by the device token, with the
 * likely cause. They are logged at error, consumed (no retry: a redelivery would fail the same way)
 * and never prune: DeviceTokenNotForTopic in particular means a wrong APNS_TOPIC, and deleting on it
 * would wipe every registered token on one bad deploy.
 */
const CONFIG_ERROR_HINTS: Record<string, string> = {
  DeviceTokenNotForTopic: 'APNS_TOPIC does not match the bundle id the device tokens were issued for',
  TopicDisallowed: 'APNS_TOPIC is not allowed for this APNs key',
  InvalidProviderToken: 'APNS_KEY_ID, APNS_TEAM_ID or APNS_KEY is wrong (Apple rejected the provider token)',
  ExpiredProviderToken: 'the provider token was rejected as expired; check the server clock',
  MissingProviderToken: 'no provider token was sent',
};
const PROVIDER_AUTH_HINT = 'APNs refused the provider credentials; check APNS_KEY_ID, APNS_TEAM_ID and APNS_KEY';

function configErrorHint(response: { status: number; reason?: string }): string | undefined {
  if (response.reason && CONFIG_ERROR_HINTS[response.reason]) return CONFIG_ERROR_HINTS[response.reason];
  // Every 403 is an authentication failure of the provider, never a per-device condition.
  if (response.status === 403) return PROVIDER_AUTH_HINT;
  return undefined;
}

// APNs caps apns-collapse-id at 64 bytes; ids here are ASCII.
const MAX_COLLAPSE_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 240;
const MAX_CONCURRENT_SENDS = 10;

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
    ): Promise<ReadonlyArray<{ token: string; sid: string; environment: PushTokenEnvironment }>>;
    /** `sid` is the read-time session: a token re-registered under another session meanwhile is kept. */
    removeByToken(token: string, options: { sid: string }): Promise<boolean>;
    removeBySids(sids: readonly string[]): Promise<number>;
  };
  sessions: {
    findLiveSids(sids: readonly string[]): Promise<ReadonlySet<string>>;
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
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
): Promise<PushDeliveryResult> {
  const storedTokens = await deps.tokens.findByUser(event.userId, 'device');
  const { tokens, pruned: orphansPruned } = await dropTokensOfEndedSessions(storedTokens, deps, logger);
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

  const outcome = await sendToTokens(tokens, headers, payload, deps, logger);
  const { delivered, failed, retryable } = outcome;
  const pruned = orphansPruned + outcome.pruned;

  logger.info('[Push] delivery finished', { category: event.category, delivered, pruned, failed });
  // Retry (and finally dead-letter) when nothing landed and at least one device may still be
  // reachable: pruned, config-error and permanently rejected tokens fail the same way on redelivery and
  // must not mask a transient failure. A partial success is not retried: collapse-id would absorb the
  // repeat, but APNs would still bill the quota and the user's other devices would re-alert.
  if (delivered === 0 && retryable > 0) {
    throw new Error(`APNs delivery failed transiently for ${retryable} of ${failed} device(s)`);
  }
  return { status: 'sent', delivered, pruned, failed };
}

export type SendLiveActivityDeps = {
  tokens: {
    findLiveActivityByQuest(
      userId: string,
      questId: string
    ): Promise<ReadonlyArray<{ token: string; sid: string; environment: PushTokenEnvironment }>>;
    removeByToken(token: string, options: { sid: string }): Promise<boolean>;
    removeLiveActivityByQuest(userId: string, questId: string): Promise<number>;
  };
  transport: ApnsTransport;
  /** The client's bundle id; live activity pushes go to `${topic}.push-type.liveactivity`. */
  topic: string;
};

export type LiveActivityDeliveryResult =
  { status: 'skipped'; reason: 'no_tokens' } | { status: 'sent'; delivered: number; pruned: number; failed: number };

/**
 * Delivers one live activity frame to the activity tokens registered for the quest. No user
 * preference, redaction or collapse-id applies: the frame is the activity's own state, not a
 * notification. An `end` frame also deletes the quest's tokens once it has been sent, since the
 * activity is over and its tokens will not be used again.
 */
export async function deliverLiveActivityPush(
  event: LiveActivityPushEvent,
  deps: SendLiveActivityDeps,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<LiveActivityDeliveryResult> {
  const tokens = await deps.tokens.findLiveActivityByQuest(event.userId, event.questId);
  if (tokens.length === 0) {
    logger.info('[LiveActivity] no activity tokens for the quest; nothing to send', { event: event.event });
    return { status: 'skipped', reason: 'no_tokens' };
  }

  const ending = event.event === 'end';
  const headers = {
    'apns-topic': `${deps.topic}.push-type.liveactivity`,
    'apns-push-type': 'liveactivity',
    // 5 is the low-power tier APNs recommends for frequent updates; the closing frame must land.
    'apns-priority': ending ? '10' : '5',
  };
  const payload = JSON.stringify({
    aps: {
      timestamp: nowSeconds,
      event: event.event,
      'content-state': event.contentState,
      ...(event.staleDate !== undefined && { 'stale-date': event.staleDate }),
      ...(event.dismissalDate !== undefined && { 'dismissal-date': event.dismissalDate }),
    },
  });

  const outcome = await sendToTokens(tokens, headers, payload, deps, logger);
  logger.info('[LiveActivity] delivery finished', { event: event.event, ...outcome });
  // Same rule as deliverPush: a transient failure is retried even next to tokens that failed for good.
  if (outcome.delivered === 0 && outcome.retryable > 0) {
    throw new Error(
      `APNs live activity delivery failed transiently for ${outcome.retryable} of ${outcome.failed} token(s)`
    );
  }
  if (ending) await deps.tokens.removeLiveActivityByQuest(event.userId, event.questId);
  return { status: 'sent', delivered: outcome.delivered, pruned: outcome.pruned, failed: outcome.failed };
}

type DeliveryTally = { delivered: number; pruned: number; failed: number; retryable: number };

/**
 * One APNs request per token, pruning tokens APNs says are dead; `retryable` counts transient failures.
 * Configuration rejections (CONFIG_ERROR_HINTS, any 403) are counted as failed, never retried or pruned.
 */
async function sendToTokens(
  tokens: ReadonlyArray<{ token: string; sid: string; environment: PushTokenEnvironment }>,
  headers: Record<string, string>,
  payload: string,
  deps: { transport: ApnsTransport; tokens: Pick<SendPushDeps['tokens'], 'removeByToken'> },
  logger: Pick<Logger, 'warn' | 'error'>
): Promise<DeliveryTally> {
  let delivered = 0;
  let pruned = 0;
  let failed = 0;
  let retryable = 0;
  const configErrors = new Map<string, { status: number; hint: string }>();
  let next = 0;
  const worker = async () => {
    while (next < tokens.length) {
      const { token, sid, environment } = tokens[next++];
      try {
        const response = await deps.transport.send({ environment, deviceToken: token, headers, payload });
        if (response.status === 200) {
          delivered++;
          continue;
        }
        failed++;
        const hint = configErrorHint(response);
        if (hint) {
          configErrors.set(response.reason ?? String(response.status), { status: response.status, hint });
          continue;
        }
        if (isUnregistered(response)) {
          try {
            if (await deps.tokens.removeByToken(token, { sid })) pruned++;
          } catch (pruneError) {
            logger.warn('[Push] failed to prune an unregistered device token', {
              error: pruneError instanceof Error ? pruneError.message : String(pruneError),
            });
          }
          continue;
        }
        if (response.reason === 'BadDeviceToken') {
          logger.error(
            '[Push] APNs reported BadDeviceToken; keeping the token (likely a sandbox/production mismatch)',
            {
              environment,
            }
          );
          continue;
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
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_SENDS, tokens.length) }, worker));

  // One error per invocation, not per token: the cause is the deployment, and every token shares it.
  for (const [reason, { status, hint }] of configErrors) {
    logger.error('[Push] APNs rejected the server configuration; push delivery is not working', {
      status,
      reason,
      likelyCause: hint,
      pushType: headers['apns-push-type'],
    });
  }
  return { delivered, pruned, failed, retryable };
}

/**
 * Revokes prune tokens eagerly (AuthSessionRepository.revokeBySid), but an expired session is deleted
 * by the TTL index on AuthSession.expiresAt (AuthSessionModel.ts) with no hook, so its tokens would
 * keep receiving pushes. One query checks every candidate sid; tokens of ended sessions are deleted
 * and not sent to.
 */
async function dropTokensOfEndedSessions<T extends { sid: string }>(
  tokens: ReadonlyArray<T>,
  deps: Pick<SendPushDeps, 'tokens' | 'sessions'>,
  logger: Pick<Logger, 'info'>
): Promise<{ tokens: T[]; pruned: number }> {
  if (tokens.length === 0) return { tokens: [], pruned: 0 };
  const liveSids = await deps.sessions.findLiveSids([...new Set(tokens.map(token => token.sid))]);
  const live = tokens.filter(token => liveSids.has(token.sid));
  if (live.length === tokens.length) return { tokens: live, pruned: 0 };

  const endedSids = [...new Set(tokens.filter(token => !liveSids.has(token.sid)).map(token => token.sid))];
  const pruned = await deps.tokens.removeBySids(endedSids);
  logger.info('[Push] pruned device tokens whose session has ended', { pruned });
  return { tokens: live, pruned };
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

/**
 * The user's opt-outs plus their active organization's redaction setting. Redaction follows the active
 * organization because chat sessions carry no organization id, so the session's own org cannot be resolved.
 */
export async function loadPushRecipient(userId: string): Promise<PushRecipient | null> {
  const user = await userRepository.findById(userId);
  if (!user) return null;
  const organization = user.organizationId ? await organizationRepository.findById(user.organizationId) : null;
  return {
    preferences: user.preferences?.pushNotifications,
    redactContent: organization?.redactPushContent === true,
  };
}

// Held across warm invocations: Apple asks providers to keep APNs connections open.
let shared: { config: ApnsConfig; transport: ApnsTransport } | undefined;

function transportFor(config: ApnsConfig): ApnsTransport {
  const held = shared;
  if (
    held &&
    held.config.keyId === config.keyId &&
    held.config.teamId === config.teamId &&
    held.config.key === config.key &&
    held.config.topic === config.topic
  ) {
    return held.transport;
  }
  held?.transport.close();
  shared = {
    config,
    transport: createHttp2ApnsTransport(config, Date.now, new Logger({ metadata: { handler: 'sendPush' } })),
  };
  return shared.transport;
}

const LIVE_ACTIVITY_DETAIL_TYPE = 'notification.liveActivity';

const handleWithContext = withEventContext(async (event, logger) => {
  const config = readApnsConfig();
  if (!config) return;
  const transport = transportFor(config);
  if (event.event === LIVE_ACTIVITY_DETAIL_TYPE) {
    const payload = NotificationEvents.LiveActivity.schema.parse(event.properties);
    logger.updateMetadata({ handler: 'sendPush', userId: payload.userId, questId: payload.questId });
    await deliverLiveActivityPush(payload, { tokens: pushTokenRepository, transport, topic: config.topic }, logger);
    return;
  }

  const payload = NotificationEvents.Push.schema.parse(event.properties);
  logger.updateMetadata({ handler: 'sendPush', userId: payload.userId, category: payload.category });
  await deliverPush(
    payload,
    {
      tokens: pushTokenRepository,
      sessions: authSessionRepository,
      loadRecipient: loadPushRecipient,
      transport,
      topic: config.topic,
      appUrl: process.env.APP_URL,
    },
    logger
  );
});

/**
 * Checked before withEventContext so an unconfigured or misconfigured deployment (preview, self-host,
 * a malformed APNS_KEY) consumes the event without opening a database connection.
 */
export const handler = async (event: EventBridgeEvent<string, unknown>): Promise<void> => {
  const config = readApnsConfig();
  if (!config) {
    new Logger({ metadata: { handler: 'sendPush' } }).info('[Push] APNs is not configured; skipping');
    return;
  }
  const keyError = apnsSigningKeyError(config.key);
  if (keyError) {
    // Consumed rather than thrown: a retry cannot fix a bad secret, and would only fill the DLQ.
    new Logger({ metadata: { handler: 'sendPush' } }).error(
      '[Push] APNS_KEY is not a usable .p8 signing key (server configuration error); push delivery is disabled',
      { error: keyError }
    );
    return;
  }
  await handleWithContext(event);
};
