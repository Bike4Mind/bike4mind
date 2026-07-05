/**
 * Webhook Delivery Queue Handler
 *
 * Handles async HTTP delivery of webhooks to subscriber endpoints.
 * Implements retry logic, signature validation, and circuit breaker patterns.
 *
 * Features:
 * - Exponential backoff with full jitter (1s -> 2s -> 4s -> 8s -> 16s)
 * - Timestamp-based HMAC-SHA256 signatures
 * - Dual ID tracking (eventId stable, deliveryId per attempt)
 * - Idempotency via cache-based deduplication (1hr TTL)
 * - HTTP status code handling (permanent failures don't retry)
 * - Respect for Retry-After headers on 429 responses
 * - 10-second timeout per delivery attempt
 */

import crypto from 'crypto';
import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  cacheRepository,
  webhookDeliveryRepository,
  webhookSubscriptionRepository,
  orgWebhookConfigRepository,
} from '@bike4mind/database';
import { WebhookDeliveryStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { decryptSecret } from '@server/security/secretEncryption';
import { validateTargetUrl } from '@server/utils/ssrfProtection';
import { Config } from '@server/utils/config';
import {
  recordWebhookDeliverySuccess,
  recordWebhookDeliveryFailure,
  recordWebhookDeliverySkipped,
} from '@server/utils/cloudwatch';

/**
 * Schema for webhook delivery messages
 */
const WebhookDeliveryPayloadSchema = z.object({
  /** Stable ID across retries (for consumer deduplication) */
  eventId: z.string(),
  /** Unique ID per attempt (for logging/debugging) */
  deliveryId: z.string(),
  /** Subscription ID for tracking */
  subscriptionId: z.string(),
  /** User who owns the subscription */
  userId: z.string(),
  /** Organization ID */
  orgId: z.string(),
  /** Target URL to deliver webhook to */
  targetUrl: z.url(),
  /** GitHub webhook payload */
  payload: z.record(z.string(), z.unknown()),
  /** Event type (push, pull_request, etc.) */
  eventType: z.string(),
  /** Repository full name */
  repository: z.string(),
  /** Current attempt number (1-indexed) */
  attempt: z.number().prefault(1),
  /** Correlation ID for request tracing */
  correlationId: z.string(),
});

type WebhookDeliveryPayload = z.infer<typeof WebhookDeliveryPayloadSchema>;

/**
 * Deduplication key prefix for tracking processed deliveries
 */
const DEDUP_KEY_PREFIX = 'webhook-delivery-';

/**
 * Deduplication TTL (1 hour)
 */
const DEDUP_TTL_MS = 60 * 60 * 1000;

/**
 * HTTP timeout for delivery attempts (10 seconds)
 */
const HTTP_TIMEOUT_MS = 10000;

/**
 * Maximum retries before giving up
 */
const MAX_RETRIES = 5;

/**
 * Circuit breaker threshold (consecutive failures)
 */
const CIRCUIT_BREAKER_THRESHOLD = 10;

/**
 * HTTP status codes that indicate permanent failure (don't retry)
 */
const PERMANENT_FAILURE_CODES = [400, 401, 403, 404, 410];

/**
 * Custom error class for retryable errors
 */
class RetryableError extends Error {
  constructor(
    message: string,
    public retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = JSON.parse(event.Records[0].body);
  const payload = WebhookDeliveryPayloadSchema.parse(body);
  const startTime = Date.now();

  logger.updateMetadata({
    handler: 'webhookDelivery',
    correlationId: payload.correlationId,
    subscriptionId: payload.subscriptionId,
    eventId: payload.eventId,
    deliveryId: payload.deliveryId,
    attempt: payload.attempt,
    targetUrl: payload.targetUrl,
    eventType: payload.eventType,
  });

  logger.info('Processing delivery attempt', {
    attempt: payload.attempt,
    maxRetries: MAX_RETRIES,
  });

  // 1. SSRF Protection - validate target URL with DNS resolution
  // Uses async validation to prevent DNS rebinding attacks
  const urlValidation = await validateTargetUrl(payload.targetUrl);
  if (!urlValidation.valid) {
    logger.error('SECURITY: SSRF attempt blocked', {
      targetUrl: payload.targetUrl,
      error: urlValidation.error,
      subscriptionId: payload.subscriptionId,
      userId: payload.userId,
    });
    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, 0, `Security error: ${urlValidation.error}`);
    return; // Don't retry - this is a security violation
  }

  // 2. Idempotency check with atomic claim
  // Uses findOneAndUpdate with $setOnInsert to prevent race conditions
  // Only the first Lambda to reach this point will successfully claim the key
  const dedupKey = `${DEDUP_KEY_PREFIX}${payload.eventId}-${payload.subscriptionId}`;
  const claimResult = await cacheRepository.claimDedup(
    dedupKey,
    { status: 'pending', startedAt: new Date().toISOString(), eventType: payload.eventType },
    DEDUP_TTL_MS
  );

  if (!claimResult.claimed) {
    logger.info('Delivery already claimed by another worker, skipping', {
      eventId: payload.eventId,
      subscriptionId: payload.subscriptionId,
      existingStatus: claimResult.existingData?.status,
    });
    return;
  }

  // 3. Check if subscription is auto-disabled (circuit breaker)
  const subscription = await webhookSubscriptionRepository.findById(payload.subscriptionId);
  if (!subscription) {
    logger.warn('Subscription not found, skipping', {
      subscriptionId: payload.subscriptionId,
    });
    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Skipped, 0, 'Subscription not found');
    return;
  }

  if (!subscription.enabled) {
    logger.warn('Subscription is disabled, skipping', {
      subscriptionId: payload.subscriptionId,
    });
    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Skipped, 0, 'Subscription is disabled');
    return;
  }

  // 4. Get org webhook config for secret (to sign the request)
  const orgConfig = await orgWebhookConfigRepository.findByOrganizationId(payload.orgId);
  if (!orgConfig) {
    logger.warn('Org webhook config not found, skipping', {
      orgId: payload.orgId,
    });
    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Skipped, 0, 'Org webhook config not found');
    return;
  }

  // 5. Decrypt the webhook secret for signing
  let secret: string;
  try {
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    if (!encryptionKey) {
      // Configuration error - log as error but don't alert as security issue
      logger.error('SECRET_ENCRYPTION_KEY not configured');
      await recordDelivery(
        payload,
        startTime,
        WebhookDeliveryStatus.Failed,
        0,
        'Configuration error: SECRET_ENCRYPTION_KEY not set'
      );
      return; // Don't retry - configuration must be fixed first
    }
    secret = decryptSecret(orgConfig.secret, encryptionKey);
  } catch (error) {
    // Differentiate between configuration errors and potential tampering
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check for authentication tag failures (indicates tampered ciphertext)
    const isTamperingIndicator =
      errorMessage.includes('authentication tag') ||
      errorMessage.includes('Unsupported state') ||
      errorMessage.includes('bad decrypt');

    if (isTamperingIndicator) {
      // Potential security incident - log at critical level
      logger.error('SECURITY: Potential secret tampering detected', {
        error: errorMessage,
        orgId: payload.orgId,
        subscriptionId: payload.subscriptionId,
      });
      await recordDelivery(
        payload,
        startTime,
        WebhookDeliveryStatus.Failed,
        0,
        'Security error: Secret verification failed - possible tampering'
      );
      // TODO: Send security alert to ops team
    } else {
      // Generic decryption error (malformed data, wrong key, etc.)
      logger.error('Failed to decrypt webhook secret', {
        error: errorMessage,
        orgId: payload.orgId,
      });
      await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, 0, 'Failed to decrypt webhook secret');
    }
    return; // Don't retry - this is a configuration/security issue
  }

  // 6. Build request with timestamp-based signature
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadString = JSON.stringify(payload.payload);
  const signedPayload = `${timestamp}.${payloadString}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  // 7. Execute HTTP with timeout (10s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(payload.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Event-ID': payload.eventId,
        'X-Webhook-Delivery-ID': payload.deliveryId,
        'X-Webhook-Timestamp': String(timestamp),
        'X-Webhook-Signature-256': `sha256=${signature}`,
        'X-Event-Type': payload.eventType,
        'User-Agent': 'Lumina5-Webhook/1.0',
      },
      body: payloadString,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const processingDurationMs = Date.now() - startTime;

    // 8. Handle response codes
    if (response.ok) {
      logger.info('Delivery successful', {
        statusCode: response.status,
        processingDurationMs,
      });

      await recordDelivery(payload, startTime, WebhookDeliveryStatus.Success, response.status);

      // Update cache entry to show successful completion
      await cacheRepository.createOrUpdate({
        key: dedupKey,
        result: { status: 'completed', processedAt: new Date().toISOString(), eventType: payload.eventType },
        expiresAt: new Date(Date.now() + DEDUP_TTL_MS),
      });

      // Reset consecutive failures on success
      await resetConsecutiveFailures(payload.subscriptionId, logger);

      return;
    }

    // Permanent failures - don't retry
    if (PERMANENT_FAILURE_CODES.includes(response.status)) {
      const errorMessage = `HTTP ${response.status}: Permanent failure - not retrying`;
      logger.warn('Permanent failure, not retrying', {
        statusCode: response.status,
        processingDurationMs,
      });

      await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, response.status, errorMessage);
      await incrementConsecutiveFailures(payload.subscriptionId, logger);

      return; // Don't throw, don't retry
    }

    // Rate limited - check Retry-After
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60;

      logger.warn('Rate limited', {
        statusCode: response.status,
        retryAfter,
        processingDurationMs,
      });

      await recordDelivery(
        payload,
        startTime,
        WebhookDeliveryStatus.Failed,
        response.status,
        `Rate limited, retry after ${retryAfter}s`
      );
      await incrementConsecutiveFailures(payload.subscriptionId, logger);

      throw new RetryableError(`Rate limited, retry after ${retryAfter}s`, retryAfter);
    }

    // Server errors - retry with backoff
    const errorMessage = `HTTP ${response.status}: Server error`;
    logger.warn('Server error, will retry', {
      statusCode: response.status,
      processingDurationMs,
    });

    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, response.status, errorMessage);
    await incrementConsecutiveFailures(payload.subscriptionId, logger);

    throw new RetryableError(errorMessage);
  } catch (error) {
    clearTimeout(timeoutId);

    const processingDurationMs = Date.now() - startTime;

    // Handle abort (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      const errorMessage = `Request timeout after ${HTTP_TIMEOUT_MS / 1000}s`;
      logger.warn('Request timeout, will retry', {
        processingDurationMs,
      });

      await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, 0, errorMessage);
      await incrementConsecutiveFailures(payload.subscriptionId, logger);

      throw new RetryableError(errorMessage);
    }

    // Re-throw RetryableError
    if (error instanceof RetryableError) {
      throw error;
    }

    // Handle other errors (network errors, etc.)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Delivery failed', {
      error: errorMessage,
      processingDurationMs,
    });

    await recordDelivery(payload, startTime, WebhookDeliveryStatus.Failed, 0, errorMessage);
    await incrementConsecutiveFailures(payload.subscriptionId, logger);

    throw new RetryableError(errorMessage);
  }
});

/**
 * Record delivery attempt in database and emit CloudWatch metrics
 */
async function recordDelivery(
  payload: WebhookDeliveryPayload,
  startTime: number,
  status: WebhookDeliveryStatus,
  httpStatus: number,
  errorMessage?: string
): Promise<void> {
  const processingDurationMs = Date.now() - startTime;

  // Record in database
  // Store payload and targetUrl only for failed deliveries (for DLQ replay)
  const shouldStorePayload = status === WebhookDeliveryStatus.Failed;

  await webhookDeliveryRepository.createIfNotExists({
    deliveryId: payload.deliveryId,
    organizationId: payload.orgId,
    subscriptionId: payload.subscriptionId,
    userId: payload.userId,
    eventType: payload.eventType,
    repository: payload.repository,
    status,
    processingDurationMs,
    errorMessage,
    correlationId: payload.correlationId,
    retryCount: payload.attempt - 1,
    // Store for DLQ replay - only for failed deliveries to save storage
    ...(shouldStorePayload && {
      payload: payload.payload,
      targetUrl: payload.targetUrl,
    }),
  });

  // Emit CloudWatch metrics
  if (status === WebhookDeliveryStatus.Success) {
    await recordWebhookDeliverySuccess(
      payload.orgId,
      payload.eventType,
      processingDurationMs,
      httpStatus,
      payload.attempt - 1
    );
  } else if (status === WebhookDeliveryStatus.Skipped) {
    await recordWebhookDeliverySkipped(payload.orgId, payload.eventType, errorMessage || 'Unknown reason');
  } else if (status === WebhookDeliveryStatus.Failed) {
    const errorType =
      httpStatus >= 400 && httpStatus < 500 ? 'ClientError' : httpStatus >= 500 ? 'ServerError' : 'NetworkError';
    await recordWebhookDeliveryFailure(payload.orgId, payload.eventType, processingDurationMs, httpStatus, errorType);
  }
}

/**
 * Increment consecutive failure count for circuit breaker using atomic operation.
 * This prevents race conditions where multiple Lambda executions could trigger
 * auto-disable simultaneously.
 */
async function incrementConsecutiveFailures(subscriptionId: string, logger: Logger): Promise<void> {
  try {
    // Use atomic increment + threshold check to prevent TOCTOU race conditions
    const result = await webhookSubscriptionRepository.incrementConsecutiveFailuresAtomic(
      subscriptionId,
      CIRCUIT_BREAKER_THRESHOLD,
      `Exceeded ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`
    );

    if (result.wasAutoDisabled) {
      logger.error('Circuit breaker triggered, subscription auto-disabled', {
        subscriptionId,
        consecutiveFailures: result.newFailureCount,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      });

      // TODO: Send notification email to org admin about auto-disable
    } else if (result.newFailureCount > 0) {
      logger.warn('Consecutive failure recorded', {
        subscriptionId,
        consecutiveFailures: result.newFailureCount,
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      });
    }
  } catch (error) {
    // Log but don't throw - circuit breaker is not critical path
    logger.warn('Failed to update consecutive failures', { error });
  }
}

/**
 * Reset consecutive failure count on successful delivery
 */
async function resetConsecutiveFailures(subscriptionId: string, logger: Logger): Promise<void> {
  try {
    await webhookSubscriptionRepository.resetConsecutiveFailures(subscriptionId);
  } catch (error) {
    // Log but don't throw - circuit breaker is not critical path
    logger.warn('Failed to reset consecutive failures', { error });
  }
}
