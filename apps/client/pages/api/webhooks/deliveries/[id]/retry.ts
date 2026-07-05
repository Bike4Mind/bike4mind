/**
 * Webhook Delivery Retry API
 *
 * Allows users to manually retry a failed webhook delivery.
 * Creates a new delivery attempt with fresh attempt count.
 *
 * Security:
 * - User can only retry their own deliveries
 * - Only failed deliveries can be retried
 *
 * @route POST /api/webhooks/deliveries/[id]/retry - Retry failed delivery
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { webhookDeliveryRepository } from '@bike4mind/database/infra';
import { webhookSubscriptionRepository } from '@bike4mind/database/infra';
import { NotFoundError, BadRequestError, TooManyRequestsError } from '@bike4mind/utils';
import { cacheRepository } from '@bike4mind/database';
import { WebhookDeliveryStatus } from '@bike4mind/common';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '@bike4mind/observability';

// Rate limit: 20 retry requests per minute per user
const RATE_LIMIT = 20;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

// MongoDB ObjectId pattern (24 hex characters)
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

interface RetryResponse {
  success: boolean;
  message: string;
  newDeliveryId?: string;
}

const handler = baseApi().post(
  asyncHandler<{}, RetryResponse, unknown, { id?: string }>(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const user = req.user;

    if (!req.query.id) {
      return res.status(400).json({ success: false, message: 'Delivery ID is required' });
    }
    const deliveryId = req.query.id;

    // Validate deliveryId is a valid MongoDB ObjectId format
    if (!OBJECT_ID_PATTERN.test(deliveryId)) {
      throw new BadRequestError('Invalid delivery ID format');
    }

    // Rate limit check (atomic) - per user
    const rateLimitKey = `webhook-retry-rate:${user.id}`;
    const rateLimitResult = await cacheRepository.incrementCounterConditional(
      rateLimitKey,
      RATE_LIMIT,
      RATE_LIMIT_WINDOW_MS
    );
    if (!rateLimitResult.success) {
      throw new TooManyRequestsError(`Rate limit exceeded. Maximum ${RATE_LIMIT} retry requests per minute.`);
    }

    const delivery = await webhookDeliveryRepository.findById(deliveryId);
    if (!delivery) {
      throw new NotFoundError('Delivery not found');
    }

    // Verify user owns this delivery
    if (delivery.userId !== user.id && !user.isAdmin) {
      throw new NotFoundError('Delivery not found');
    }

    // Only allow retrying failed deliveries
    if (delivery.status !== WebhookDeliveryStatus.Failed) {
      throw new BadRequestError('Only failed deliveries can be retried');
    }

    // Find the subscription to get target URL
    if (!delivery.subscriptionId) {
      throw new BadRequestError('Cannot retry delivery without subscription');
    }

    const subscription = await webhookSubscriptionRepository.findById(delivery.subscriptionId);
    if (!subscription) {
      throw new BadRequestError('Subscription not found');
    }

    if (!subscription.enabled) {
      throw new BadRequestError('Cannot retry delivery for disabled subscription');
    }

    // Retry requires the original payload to have been stored
    if (!delivery.payload || Object.keys(delivery.payload).length === 0) {
      throw new BadRequestError(
        'Cannot retry this delivery - original payload was not stored. ' +
          'Only deliveries that failed after the payload storage feature was added can be retried.'
      );
    }

    if (!delivery.targetUrl) {
      throw new BadRequestError(
        'Cannot retry this delivery - target URL was not stored. ' +
          'Only deliveries that failed after the payload storage feature was added can be retried.'
      );
    }

    let queueUrl: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queueUrl = (Resource as any).webhookDeliveryQueue?.url || '';
      if (!queueUrl) {
        throw new Error('Queue URL not found');
      }
    } catch {
      Logger.warn('[RETRY-DELIVERY] Could not get queue URL from Resource');
      return res.status(503).json({
        success: false,
        message: 'Retry is not available in this environment',
      });
    }

    const newDeliveryId = uuidv4();
    const message = {
      eventId: delivery.deliveryId, // Keep original delivery ID as event ID for tracking
      deliveryId: newDeliveryId,
      subscriptionId: delivery.subscriptionId,
      userId: delivery.userId,
      orgId: delivery.organizationId,
      targetUrl: delivery.targetUrl, // Use stored target URL
      payload: delivery.payload, // Use stored payload
      eventType: delivery.eventType,
      repository: delivery.repository,
      attempt: 1, // Fresh start
      correlationId: delivery.correlationId || uuidv4(),
    };

    const sqsClient = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      })
    );

    Logger.info('[RETRY-DELIVERY] Delivery queued for retry', {
      originalDeliveryId: delivery.deliveryId,
      newDeliveryId,
      userId: user.id,
    });

    return res.status(200).json({
      success: true,
      message: 'Delivery queued for retry',
      newDeliveryId,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
