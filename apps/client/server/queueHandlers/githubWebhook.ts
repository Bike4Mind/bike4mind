/**
 * GitHub Webhook Queue Handler
 *
 * Processes GitHub webhook events asynchronously from SQS.
 * The webhook endpoint validates and enqueues; this handler processes.
 *
 * Supports both:
 * - Per-user MCP server webhooks (existing)
 * - Organization-level webhooks with subscriber fan-out (new)
 */

import { z } from 'zod';
import { dispatchWithLogger } from '@server/queueHandlers/utils';
import {
  mcpServerRepository,
  cacheRepository,
  webhookSubscriptionRepository,
  webhookDeliveryRepository,
  organizationRepository,
  webhookAuditLogRepository,
} from '@bike4mind/database';
import { WebhookDeliveryStatus, WebhookAuditStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createHandlerRegistry, getHandler } from '@server/integrations/github/handlers';
import { isValidGitHubEventType, GitHubWebhookPayload, GitHubHandlerContext } from '@server/integrations/github/types';
import { dispatchReviewToSreRevision } from '@server/integrations/github/sreRevisionDispatch';
import { sanitizeDispatchError, sanitizeHandlerError, sanitizeNotificationError } from './sanitizeWebhookError';
import { emitWebhookDeliveryMetric, WebhookMetrics } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';

/**
 * Schema for per-user MCP server webhook messages
 */
const McpServerWebhookPayloadSchema = z.object({
  deliveryId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  mcpServerId: z.string(),
  userId: z.string(),
  receivedAt: z.string(),
  correlationId: z.string(),
  isOrgWebhook: z.literal(false).optional(),
});

/**
 * Schema for organization-level webhook messages (fan-out)
 */
const OrgWebhookPayloadSchema = z.object({
  deliveryId: z.string(),
  eventType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  orgId: z.string(),
  isOrgWebhook: z.literal(true),
  receivedAt: z.string(),
  correlationId: z.string(),
});

/**
 * Combined schema for queue messages
 */
const GithubWebhookPayloadSchema = z.union([OrgWebhookPayloadSchema, McpServerWebhookPayloadSchema]);

/**
 * Deduplication key prefix for tracking processed events
 * Uses different prefix than endpoint claim key to distinguish
 */
const DEDUP_KEY_PREFIX = 'github-webhook-processed-';

/**
 * Deduplication TTL matches the endpoint (1 hour)
 */
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 hour

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = JSON.parse(event.Records[0].body);
  const parsed = GithubWebhookPayloadSchema.parse(body);

  if ('isOrgWebhook' in parsed && parsed.isOrgWebhook) {
    // Organization-level webhook: fan-out to subscribers
    await processOrgWebhook(parsed, logger);
  } else {
    // Per-user MCP server webhook: existing flow
    const mcpPayload = parsed as z.infer<typeof McpServerWebhookPayloadSchema>;
    await processMcpServerWebhook(mcpPayload, logger);
  }
});

/**
 * Process organization-level webhook by fanning out to all subscribers
 */
async function processOrgWebhook(message: z.infer<typeof OrgWebhookPayloadSchema>, logger: Logger) {
  const { deliveryId, eventType, payload, orgId, correlationId } = message;
  const startTime = Date.now();

  logger.updateMetadata({ handler: 'githubWebhook', deliveryId, eventType, orgId, correlationId, isOrgWebhook: true });
  logger.info('Processing org webhook for fan-out');

  // Update audit log to processing status (fire-and-forget)
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Processing,
    })
    .catch(err => {
      logger.error('Failed to update audit log to processing', { error: err, deliveryId });
    });

  const repository = (payload as { repository?: { full_name?: string } }).repository?.full_name || 'unknown';

  // SRE revision detection runs independently of notification subscribers.
  // This ensures change requests on sre-fix/* PRs always trigger revision cycles,
  // even when no webhook subscribers exist for this org+repo.
  if (eventType === 'pull_request_review') {
    try {
      await dispatchReviewToSreRevision(payload, logger);
    } catch (err) {
      logger.error('SRE revision detection failed (non-fatal)', { error: err, deliveryId });
    }
  }

  const subscribers = await webhookSubscriptionRepository.findByOrgAndRepo(orgId, repository);

  if (subscribers.length === 0) {
    logger.info('No subscribers found for org webhook', { orgId, repository });
    return;
  }

  logger.info('Found subscribers for fan-out', {
    subscriberCount: subscribers.length,
    orgId,
    repository,
  });

  if (!isValidGitHubEventType(eventType)) {
    logger.info('Unsupported event type, skipping', { eventType });
    return;
  }

  const registry = createHandlerRegistry(logger);
  const handler = getHandler(registry, eventType);

  if (!handler) {
    logger.info('No handler registered for event type');
    return;
  }

  // Fetch org once outside the loop to avoid a redundant DB lookup per subscriber.
  const org = await organizationRepository.findById(orgId);
  if (!org) {
    logger.warn('Organization not found, skipping all subscribers', { orgId });
    // Record skipped delivery for all subscribers
    for (const subscriber of subscribers) {
      try {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Skipped,
          processingDurationMs: 0,
          errorMessage: 'Organization no longer exists',
          correlationId,
          deliveryKind: 'org_notification',
        });
      } catch (recordError) {
        logger.error('Failed to record skipped delivery', {
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          error: recordError,
        });
      }
    }
    return;
  }

  // Phase 1: Collect valid subscribers (dedup, membership, event filter checks)
  const validSubscribers = [];
  for (const subscriber of subscribers) {
    // Check per-subscriber deduplication
    const existingDelivery = await webhookDeliveryRepository.findByDeliveryAndSubscription(deliveryId, subscriber.id);
    if (existingDelivery) {
      logger.debug('Delivery already processed for subscriber', {
        subscriptionId: subscriber.id,
        userId: subscriber.userId,
      });
      continue;
    }

    // Check if subscriber is still a member of the org (membership can change)
    const isOwner = org.userId === subscriber.userId;
    const isManager = org.managerId === subscriber.userId;
    const isMember = org.users?.some(u => u.userId === subscriber.userId);

    if (!isOwner && !isManager && !isMember) {
      logger.warn('Subscriber no longer has org access, skipping', {
        subscriptionId: subscriber.id,
        userId: subscriber.userId,
      });

      // Record skipped delivery
      try {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Skipped,
          processingDurationMs: 0,
          errorMessage: 'User no longer has organization access',
          correlationId,
          deliveryKind: 'org_notification',
        });
      } catch (recordError) {
        logger.error('Failed to record skipped delivery', {
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          error: recordError,
        });
      }
      continue;
    }

    // Check if subscriber wants this event type
    if (subscriber.events.length > 0 && !subscriber.events.includes(eventType)) {
      logger.debug('Subscriber not subscribed to event type', {
        subscriptionId: subscriber.id,
        eventType,
        subscribedEvents: subscriber.events,
      });
      continue;
    }

    validSubscribers.push(subscriber);
  }

  if (validSubscribers.length === 0) {
    logger.info('No valid subscribers after filtering', { orgId, repository });
    return;
  }

  // Phase 2: Run handler ONCE with orgId context (notifier filters by subscription internally)
  const handlerContext: GitHubHandlerContext = { orgId };
  const handlerStartTime = Date.now();
  let handlerError: Error | null = null;
  let notifiedUserIds: string[] = [];
  let failedNotifications: Array<{ userId: string; error: string }> = [];
  let notificationDispatchError: string | undefined;

  try {
    const result = await handler.handle(payload as GitHubWebhookPayload, undefined, handlerContext);
    notifiedUserIds = result.notifiedUserIds;
    failedNotifications = result.failedNotifications ?? [];
    notificationDispatchError = result.notificationDispatchError;
    logger.info('Event handler executed once for org', {
      orgId,
      validSubscriberCount: validSubscribers.length,
      notifiedUserCount: notifiedUserIds.length,
      failedNotificationCount: failedNotifications.length,
      hasDispatchError: Boolean(notificationDispatchError),
    });
  } catch (error) {
    handlerError = error instanceof Error ? error : new Error('Unknown error');
    logger.error('Handler failed for org webhook', { orgId, error });
  }

  const processingDurationMs = Date.now() - handlerStartTime;

  // Phase 3: Record delivery for all valid subscribers using priority:
  //   1. Handler threw                 -> all subscribers Failed (handlerError)
  //   2. Per-user notification failure -> that subscriber Failed (specific error)
  //   3. Notified successfully         -> Success
  //   4. Dispatch error                -> that subscriber Failed (couldn't tell
  //      who was a target after a pre-loop failure; over-mark beats silently
  //      skipping for observability)
  //   5. None of the above             -> Skipped (genuinely not a target)
  const notifiedSet = new Set(notifiedUserIds);
  const failedByUser = new Map(failedNotifications.map(f => [f.userId, f.error]));

  for (const subscriber of validSubscribers) {
    try {
      if (handlerError) {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Failed,
          processingDurationMs,
          // Sanitized for the DLQ dashboard - full message stays in structured logs above.
          errorMessage: sanitizeHandlerError(handlerError.message),
          correlationId,
          deliveryKind: 'org_notification',
        });
      } else if (failedByUser.has(subscriber.userId)) {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Failed,
          processingDurationMs,
          errorMessage: sanitizeNotificationError(failedByUser.get(subscriber.userId) ?? ''),
          correlationId,
          deliveryKind: 'org_notification',
        });
      } else if (notifiedSet.has(subscriber.userId)) {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Success,
          processingDurationMs,
          correlationId,
          deliveryKind: 'org_notification',
        });
      } else if (notificationDispatchError) {
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Failed,
          processingDurationMs,
          errorMessage: sanitizeDispatchError(notificationDispatchError),
          correlationId,
          deliveryKind: 'org_notification',
        });
      } else {
        // Event processed successfully but this subscriber wasn't a notification target
        await webhookDeliveryRepository.createIfNotExists({
          deliveryId,
          organizationId: orgId,
          subscriptionId: subscriber.id,
          userId: subscriber.userId,
          eventType,
          repository,
          status: WebhookDeliveryStatus.Skipped,
          processingDurationMs,
          errorMessage: 'Event processed but user was not a notification target',
          correlationId,
          deliveryKind: 'org_notification',
        });
      }
    } catch (recordError) {
      logger.error('Failed to record delivery for subscriber', {
        subscriptionId: subscriber.id,
        userId: subscriber.userId,
        error: recordError,
      });
    }
  }

  const totalDurationMs = Date.now() - startTime;

  // Emit the CloudWatch DeliveryFailed metric so the existing
  // `webhookDeliveryHighFailures` alarm pages on-call when notification failures
  // spike. Aggregated by error category to keep cardinality low.
  await emitDeliveryFailureMetrics(orgId, eventType, {
    handlerErrorCount: handlerError ? validSubscribers.length : 0,
    perUserFailureCount: failedNotifications.length,
    dispatchErrorCount:
      notificationDispatchError && !handlerError
        ? validSubscribers.filter(s => !notifiedSet.has(s.userId) && !failedByUser.has(s.userId)).length
        : 0,
  }).catch(err => {
    logger.error('Failed to emit DeliveryFailed metric', { error: err, deliveryId });
  });

  logger.info('Org webhook processing complete', {
    validSubscriberCount: validSubscribers.length,
    totalSubscriberCount: subscribers.length,
    notifiedUserCount: notifiedUserIds.length,
    failedNotificationCount: failedNotifications.length,
    hasDispatchError: Boolean(notificationDispatchError),
    success: !handlerError && failedNotifications.length === 0 && !notificationDispatchError,
    totalDurationMs,
  });

  // Update audit log to completed status (fire-and-forget)
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Completed,
      processedAt: new Date(),
      processingDurationMs: totalDurationMs,
      actions: [
        {
          type: 'fan_out',
          status: 'success',
          details: { subscriberCount: subscribers.length },
          durationMs: totalDurationMs,
        },
      ],
    })
    .catch(err => {
      logger.error('Failed to update audit log to completed', { error: err, deliveryId });
    });
}

/**
 * Emit DeliveryFailed metrics in batched calls, one per error category, so
 * the alarm sees realistic totals without exploding metric cardinality.
 */
async function emitDeliveryFailureMetrics(
  orgId: string,
  eventType: string,
  counts: { handlerErrorCount: number; perUserFailureCount: number; dispatchErrorCount: number }
): Promise<void> {
  const baseDimensions = { orgId, eventType };
  const emissions: Array<Promise<void>> = [];

  if (counts.handlerErrorCount > 0) {
    emissions.push(
      emitWebhookDeliveryMetric(
        WebhookMetrics.DELIVERY_FAILED,
        counts.handlerErrorCount,
        { ...baseDimensions, errorType: 'handler_threw' },
        StandardUnit.Count
      )
    );
  }
  if (counts.perUserFailureCount > 0) {
    emissions.push(
      emitWebhookDeliveryMetric(
        WebhookMetrics.DELIVERY_FAILED,
        counts.perUserFailureCount,
        { ...baseDimensions, errorType: 'per_user_notification' },
        StandardUnit.Count
      )
    );
  }
  if (counts.dispatchErrorCount > 0) {
    emissions.push(
      emitWebhookDeliveryMetric(
        WebhookMetrics.DELIVERY_FAILED,
        counts.dispatchErrorCount,
        { ...baseDimensions, errorType: 'notification_dispatch' },
        StandardUnit.Count
      )
    );
  }

  await Promise.all(emissions);
}

/**
 * Process per-user MCP server webhook (existing flow)
 */
async function processMcpServerWebhook(message: z.infer<typeof McpServerWebhookPayloadSchema>, logger: Logger) {
  const { deliveryId, eventType, payload, mcpServerId, userId, correlationId } = message;
  const startTime = Date.now();

  logger.updateMetadata({ handler: 'githubWebhook', deliveryId, eventType, mcpServerId, correlationId, userId });
  logger.info('Processing webhook event');

  // Update audit log to processing status (fire-and-forget)
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Processing,
    })
    .catch(err => {
      logger.error('Failed to update audit log to processing', { error: err, deliveryId });
    });

  // CRITICAL: Re-verify idempotency (SQS can deliver duplicates)
  // Use different key than endpoint claim to track actual processing
  const processedKey = `${DEDUP_KEY_PREFIX}${deliveryId}`;
  const existing = await cacheRepository.findByKey(processedKey);
  if (existing && existing.expiresAt > new Date()) {
    logger.info('Event already processed, skipping', { deliveryId });
    return; // Success - don't throw, don't retry
  }

  // Get MCP server (may have been deleted since enqueueing)
  const mcpServer = await mcpServerRepository.findById(mcpServerId);
  if (!mcpServer) {
    logger.warn('MCP server not found, skipping', { mcpServerId });
    return; // Don't retry - server was deleted
  }

  // SRE revision detection runs independently of the handler registry.
  // Mirrors processOrgWebhook - no orgId needed; config is loaded from
  // adminSettingsRepository directly inside the function.
  if (eventType === 'pull_request_review') {
    try {
      await dispatchReviewToSreRevision(payload, logger);
    } catch (err) {
      logger.error('SRE revision detection failed (non-fatal)', { error: err, deliveryId });
    }
  }

  // Route to appropriate handler
  if (!isValidGitHubEventType(eventType)) {
    logger.info('Unsupported event type, skipping', { eventType });
    return;
  }

  const registry = createHandlerRegistry(logger);
  const handler = getHandler(registry, eventType);

  if (handler) {
    try {
      await handler.handle(payload as GitHubWebhookPayload, mcpServer);
      logger.info('Event processed successfully');
    } catch (error) {
      const processingDurationMs = Date.now() - startTime;
      logger.error('Handler failed for event', { eventType, error });

      // Update audit log to failed status (fire-and-forget)
      webhookAuditLogRepository
        .updateByDeliveryId(deliveryId, {
          status: WebhookAuditStatus.Failed,
          processedAt: new Date(),
          processingDurationMs,
          actions: [
            {
              type: 'handler_execution',
              status: 'failed',
              durationMs: processingDurationMs,
            },
          ],
          error: {
            message: error instanceof Error ? error.message : 'Unknown error',
            // Note: Stack traces intentionally excluded from database for security
          },
        })
        .catch(err => {
          logger.error('Failed to update audit log to failed', { error: err, deliveryId });
        });

      throw error; // Re-throw so SQS can retry
    }
  } else {
    logger.info('No handler registered for event type');
  }

  // Mark as processed (prevents duplicate processing on SQS retry).
  // Only reached on success - handler errors re-throw above.
  await cacheRepository.createOrUpdate({
    key: processedKey,
    result: { processedAt: new Date().toISOString(), eventType },
    expiresAt: new Date(Date.now() + DEDUP_TTL_MS),
  });

  await mcpServerRepository.updateGitHubWebhookLastDelivery(mcpServerId);

  const processingDurationMs = Date.now() - startTime;

  // Update audit log to completed status (fire-and-forget)
  webhookAuditLogRepository
    .updateByDeliveryId(deliveryId, {
      status: WebhookAuditStatus.Completed,
      processedAt: new Date(),
      processingDurationMs,
      actions: [
        {
          type: 'handler_execution',
          status: 'success',
          durationMs: processingDurationMs,
        },
      ],
    })
    .catch(err => {
      logger.error('Failed to update audit log to completed', { error: err, deliveryId });
    });
}
