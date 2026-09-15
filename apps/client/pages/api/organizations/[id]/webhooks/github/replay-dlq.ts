/**
 * Organization Webhook DLQ Replay API
 *
 * Allows admins to replay failed webhook deliveries from the Dead Letter Queue.
 * Implements rate limiting to prevent thundering herd on subscriber endpoints.
 *
 * Security:
 * - Requires user to have update access on the organization
 * - Rate limited to max 10 replays/second
 *
 * @route POST /api/organizations/[id]/webhooks/github/replay-dlq - Replay failed deliveries
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { orgWebhookConfigRepository } from '@bike4mind/database/infra';
import { webhookDeliveryRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError, TooManyRequestsError } from '@bike4mind/utils';
import { cacheRepository } from '@bike4mind/database';
import { WebhookDeliveryStatus } from '@bike4mind/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@bike4mind/observability';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { classifyReplayability } from '@server/integrations/github/webhookReplayClassifier';

// Rate limit: max 10 replays per second (for delivery throttling)
const REPLAY_RATE_LIMIT = 10;
const REPLAY_DELAY_MS = 1000 / REPLAY_RATE_LIMIT; // 100ms between each

// API rate limit: 5 replay requests per minute per organization
const API_RATE_LIMIT = 5;
const API_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

interface ReplayRequest {
  deliveryIds?: string[];
  all?: boolean;
}

interface ReplayResponse {
  success: boolean;
  replayed: number;
  skipped: number;
  failed: number;
  message: string;
  /**
   * Breakdown of why deliveries were skipped, so the UI can distinguish
   * "not replayable via this mechanism" (org_notification kind, no payload)
   * from "replayable in principle but data was lost" (older outbound_http
   * records missing payload or targetUrl).
   */
  skippedBreakdown?: {
    notificationKind: number;
    missingPayload: number;
    missingTargetUrl: number;
  };
}

const handler = baseApi().post(
  asyncHandler<{}, ReplayResponse, ReplayRequest, { id?: string }>(async (req, res) => {
    const orgId = req.query.id!;
    const user = req.user!;
    const { deliveryIds, all } = req.body || {};

    // Rate limit check (atomic)
    const rateLimitKey = `webhook-replay-rate:${orgId}`;
    const rateLimitResult = await cacheRepository.incrementCounterConditional(
      rateLimitKey,
      API_RATE_LIMIT,
      API_RATE_LIMIT_WINDOW_MS
    );
    if (!rateLimitResult.success) {
      throw new TooManyRequestsError(
        `Rate limit exceeded. Maximum ${API_RATE_LIMIT} replay requests per minute per organization.`
      );
    }

    await verifyOrgAccess(user, orgId);

    const webhookConfig = await orgWebhookConfigRepository.findByOrganizationId(orgId);
    if (!webhookConfig) {
      throw new NotFoundError('Webhook configuration not found');
    }

    // Validate request
    if (!deliveryIds && !all) {
      throw new BadRequestError('Either deliveryIds or all must be specified');
    }

    if (deliveryIds && all) {
      throw new BadRequestError('Cannot specify both deliveryIds and all');
    }

    // Validate deliveryIds array
    if (deliveryIds) {
      if (!Array.isArray(deliveryIds)) {
        throw new BadRequestError('deliveryIds must be an array');
      }
      if (deliveryIds.length === 0) {
        throw new BadRequestError('deliveryIds array cannot be empty');
      }
      if (deliveryIds.length > 100) {
        throw new BadRequestError('deliveryIds array cannot exceed 100 items');
      }
      // Validate each ID is a valid format (UUID or MongoDB ObjectId)
      for (const id of deliveryIds) {
        if (typeof id !== 'string' || id.length === 0) {
          throw new BadRequestError('Each deliveryId must be a non-empty string');
        }
      }
    }

    // Find failed deliveries to replay
    let failedDeliveries;
    if (all) {
      failedDeliveries = await webhookDeliveryRepository.find({
        organizationId: orgId,
        status: WebhookDeliveryStatus.Failed,
      });
    } else if (deliveryIds) {
      failedDeliveries = await webhookDeliveryRepository.find({
        deliveryId: { $in: deliveryIds },
        organizationId: orgId,
        status: WebhookDeliveryStatus.Failed,
      });
    }

    if (!failedDeliveries || failedDeliveries.length === 0) {
      return res.status(200).json({
        success: true,
        replayed: 0,
        skipped: 0,
        failed: 0,
        message: 'No failed deliveries found to replay',
      });
    }

    // Limit to prevent overwhelming the queue
    const MAX_REPLAY_BATCH = 100;
    if (failedDeliveries.length > MAX_REPLAY_BATCH) {
      throw new BadRequestError(
        `Too many deliveries to replay (${failedDeliveries.length}). ` +
          `Maximum is ${MAX_REPLAY_BATCH}. Please use deliveryIds to replay in batches.`
      );
    }

    const sqsClient = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    let queueUrl: string;
    try {
      // In SST, queue URLs are available through Resource binding
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queueUrl = (Resource as any).webhookDeliveryQueue?.url || '';
      if (!queueUrl) {
        throw new Error('Queue URL not found');
      }
    } catch {
      // Fallback for local development
      Logger.warn('[REPLAY-DLQ] Could not get queue URL from Resource, using placeholder');
      return res.status(503).json({
        success: false,
        replayed: 0,
        skipped: 0,
        failed: 0,
        message: 'DLQ replay is not available in this environment',
      });
    }

    // Re-enqueue deliveries with rate limiting
    let replayed = 0;
    let skipped = 0;
    let failed = 0;
    let skippedNotificationKind = 0;
    let skippedMissingPayload = 0;
    let skippedMissingTargetUrl = 0;
    for (const delivery of failedDeliveries) {
      try {
        const skipReason = classifyReplayability(delivery);
        if (skipReason === 'notification_kind') {
          Logger.info('[REPLAY-DLQ] Skipping notification-kind delivery (not replayable via this endpoint)', {
            deliveryId: delivery.deliveryId,
          });
          skipped++;
          skippedNotificationKind++;
          continue;
        }
        if (skipReason === 'missing_payload') {
          Logger.warn('[REPLAY-DLQ] Skipping delivery without stored payload', {
            deliveryId: delivery.deliveryId,
          });
          skipped++;
          skippedMissingPayload++;
          continue;
        }
        if (skipReason === 'missing_target_url') {
          Logger.warn('[REPLAY-DLQ] Skipping delivery without stored targetUrl', {
            deliveryId: delivery.deliveryId,
          });
          skipped++;
          skippedMissingTargetUrl++;
          continue;
        }

        // Create new delivery message with stored payload and fresh attempt count
        const message = {
          eventId: delivery.deliveryId, // Keep original delivery ID as event ID for tracking
          deliveryId: uuidv4(), // New delivery ID for this attempt
          subscriptionId: delivery.subscriptionId,
          userId: delivery.userId,
          orgId: delivery.organizationId,
          targetUrl: delivery.targetUrl,
          payload: delivery.payload,
          eventType: delivery.eventType,
          repository: delivery.repository,
          attempt: 1, // Fresh start
          correlationId: delivery.correlationId || uuidv4(),
        };

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(message),
          })
        );

        // Note: Delivery records are append-only audit logs
        // The original delivery record is not updated - the new delivery will create a new record

        replayed++;

        // Rate limiting delay between attempts
        const processed = replayed + skipped + failed;
        if (processed < failedDeliveries.length) {
          await new Promise(resolve => setTimeout(resolve, REPLAY_DELAY_MS));
        }
      } catch (error) {
        Logger.error('[REPLAY-DLQ] Failed to send to SQS', {
          deliveryId: delivery.deliveryId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    Logger.info('[REPLAY-DLQ] DLQ replay completed', {
      organizationId: orgId,
      userId: user.id,
      replayed,
      skipped,
      failed,
      total: failedDeliveries.length,
    });

    // Per-skip-reason breakdown so admins know why a record wasn't replayed
    // (notification deliveries are never replayable here; legacy records may be).
    const parts: string[] = [];
    if (replayed > 0) parts.push(`${replayed} queued`);
    const skipParts: string[] = [];
    if (skippedNotificationKind > 0) skipParts.push(`${skippedNotificationKind} notification (not replayable here)`);
    if (skippedMissingPayload > 0) skipParts.push(`${skippedMissingPayload} missing payload`);
    if (skippedMissingTargetUrl > 0) skipParts.push(`${skippedMissingTargetUrl} missing targetUrl`);
    if (skipParts.length > 0) parts.push(`${skipped} skipped (${skipParts.join('; ')})`);
    if (failed > 0) parts.push(`${failed} failed (SQS error)`);

    const isPartialSuccess = replayed > 0 && (skipped > 0 || failed > 0);
    const isCompleteFailure = replayed === 0 && (skipped > 0 || failed > 0);

    return res.status(200).json({
      success: !isCompleteFailure,
      replayed,
      skipped,
      failed,
      skippedBreakdown: {
        notificationKind: skippedNotificationKind,
        missingPayload: skippedMissingPayload,
        missingTargetUrl: skippedMissingTargetUrl,
      },
      message: isPartialSuccess
        ? `Partial success: ${parts.join(', ')}`
        : isCompleteFailure
          ? `Failed to replay deliveries: ${parts.join(', ')}`
          : `Successfully queued ${replayed} deliveries for replay`,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
