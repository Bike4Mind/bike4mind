import { randomUUID } from 'crypto';
import type { SQSEvent } from 'aws-lambda';
import { questRepository, sessionRepository, userApiKeyRepository } from '@bike4mind/database';
import { ApiKeyStatus, GENERATION_CALLBACK_EVENT_TYPE, type IQuestCallback } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { getDeliveryAttempt, isFinalDeliveryAttempt } from '@server/queueHandlers/sqsDelivery';
import { GenerationCallbackMessageSchema } from '@server/generationCallback/messages';
import { toQuestPollBody } from '@server/utils/questPollBody';
import { assertUrlAllowed, SsrfError } from '@server/utils/ssrfProtection';
import {
  buildSignedWebhookHeaders,
  PERMANENT_FAILURE_CODES,
  RetryableError,
  WEBHOOK_HTTP_TIMEOUT_MS,
} from '@server/webhooks/signedWebhook';

/** Mirrors generationCallbackQueue's `dlq.retry` in infra/queues.ts; keep the two in sync. */
export const GENERATION_CALLBACK_MAX_RECEIVE_COUNT = 5;

/** Key states that may still sign: a revoked or expired key's callbacks are dropped, not sent. */
const SIGNING_KEY_STATUSES: readonly ApiKeyStatus[] = [ApiKeyStatus.ACTIVE, ApiKeyStatus.RATE_LIMITED];

type AttemptResult =
  | { kind: 'delivered'; statusCode: number }
  /** Worth another SQS attempt (timeout, network error, 5xx, 429). */
  | { kind: 'retryable'; statusCode?: number; error: string }
  /** Retrying cannot fix it (receiver 4xx, revoked key, blocked target). */
  | { kind: 'permanent'; statusCode?: number; error: string };

/**
 * Delivers one generation completion callback: a POST of the quest's poll body, signed with the
 * calling API key's secret (server/webhooks/signedWebhook.ts). Armed and enqueued by
 * server/generationCallback/dispatchQuestCallback.ts.
 *
 * Everything is re-read per attempt, so a retry signs with the key's current secret and a
 * key revoked mid-retry stops the delivery. A retryable failure throws for SQS redelivery; the
 * last attempt records `failed` instead, so the quest never reads as still in flight.
 */
export const dispatch = dispatchWithLogger(async (event: SQSEvent, _context, logger) => {
  const message = GenerationCallbackMessageSchema.parse(JSON.parse(event.Records[0].body));
  const attempt = getDeliveryAttempt(event);
  logger.updateMetadata({ handler: 'generationCallback', questId: message.questId, attempt });

  const callback = await questRepository.findCallbackById(message.questId);
  // `failed` is re-attempted on purpose: that is what a DLQ replay of this message is asking for.
  if (!callback || (callback.state !== 'dispatched' && callback.state !== 'failed')) {
    logger.warn('No dispatched callback on quest; skipping', { state: callback?.state });
    return;
  }

  const result = await attemptDelivery(message.questId, callback, logger);

  if (result.kind === 'delivered') {
    await questRepository.recordCallbackAttempt(message.questId, { state: 'delivered', statusCode: result.statusCode });
    logger.info('Generation callback delivered', { statusCode: result.statusCode });
    return;
  }

  if (result.kind === 'retryable' && !isFinalDeliveryAttempt(event, GENERATION_CALLBACK_MAX_RECEIVE_COUNT)) {
    await questRepository.recordCallbackAttempt(message.questId, {
      state: 'dispatched',
      statusCode: result.statusCode,
      error: result.error,
    });
    logger.warn('Generation callback attempt failed; SQS will retry', { error: result.error });
    throw new RetryableError(result.error);
  }

  await questRepository.recordCallbackAttempt(message.questId, {
    state: 'failed',
    statusCode: result.statusCode,
    error: result.error,
  });
  logger.warn('Generation callback failed permanently', { statusCode: result.statusCode, error: result.error });
});

async function attemptDelivery(
  questId: string,
  callback: Pick<IQuestCallback, 'url' | 'apiKeyId' | 'eventId'>,
  logger: Logger
): Promise<AttemptResult> {
  const signing = await userApiKeyRepository.findCallbackSigningSecret(callback.apiKeyId);
  const isExpired = !!signing?.expiresAt && signing.expiresAt.getTime() <= Date.now();
  if (!signing || !SIGNING_KEY_STATUSES.includes(signing.status) || isExpired) {
    return { kind: 'permanent', error: 'Signing API key is revoked, expired or has no signing secret' };
  }

  const quest = await questRepository.findById(questId);
  if (!quest) return { kind: 'permanent', error: 'Quest no longer exists' };

  try {
    await assertUrlAllowed(callback.url);
  } catch (error) {
    if (!(error instanceof SsrfError)) throw error;
    logger.warn('SECURITY: generation callback target blocked', { error: error.message });
    return { kind: 'permanent', error: `Callback URL not allowed: ${error.message}` };
  }

  // Same redaction the poll applies: the full promptMeta only if the key's owner owns the session.
  const session = await sessionRepository.findById(quest.sessionId);
  const body = JSON.stringify(toQuestPollBody(quest, { isOwner: session?.userId === signing.userId }));
  const headers = buildSignedWebhookHeaders({
    secret: signing.secret,
    body,
    eventId: callback.eventId,
    deliveryId: randomUUID(),
    eventType: GENERATION_CALLBACK_EVENT_TYPE,
  });

  let response: Response;
  try {
    response = await fetch(callback.url, {
      method: 'POST',
      headers,
      body,
      // Not followed: the target was validated, a redirect hop was not.
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      kind: 'retryable',
      error: isTimeout ? `Request timeout after ${WEBHOOK_HTTP_TIMEOUT_MS / 1000}s` : errorMessage(error),
    };
  }

  if (response.ok) return { kind: 'delivered', statusCode: response.status };
  if (response.status >= 300 && response.status < 400) {
    return {
      kind: 'permanent',
      statusCode: response.status,
      error: `HTTP ${response.status}: redirects are not followed`,
    };
  }
  if (PERMANENT_FAILURE_CODES.includes(response.status)) {
    return { kind: 'permanent', statusCode: response.status, error: `HTTP ${response.status}: permanent failure` };
  }
  return { kind: 'retryable', statusCode: response.status, error: `HTTP ${response.status}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
