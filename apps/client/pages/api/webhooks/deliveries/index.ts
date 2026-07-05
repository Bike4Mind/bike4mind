/**
 * User Webhook Delivery History API
 *
 * Provides paginated access to webhook delivery history for the current user.
 * Includes filtering by subscription, status, and date range.
 *
 * Security:
 * - All queries filter by userId to ensure users can only see their own deliveries
 *
 * @route GET /api/webhooks/deliveries - List deliveries with pagination
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { webhookDeliveryRepository } from '@bike4mind/database/infra';
import { webhookSubscriptionRepository } from '@bike4mind/database/infra';
import { BadRequestError } from '@bike4mind/utils';
import { WebhookDeliveryStatus, IWebhookDeliveryDocument } from '@bike4mind/common';

interface DeliveryListQuery {
  subscriptionId?: string;
  status?: WebhookDeliveryStatus;
  since?: string;
  skip?: string;
  limit?: string;
}

interface DeliveryListResponse {
  deliveries: IWebhookDeliveryDocument[];
  pagination: {
    skip: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}

const handler = baseApi().get(
  asyncHandler<{}, DeliveryListResponse, unknown, DeliveryListQuery>(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' } as unknown as DeliveryListResponse);
    }
    const user = req.user;
    const { subscriptionId, status, since, skip: skipStr, limit: limitStr } = req.query;

    const skip = skipStr ? parseInt(skipStr, 10) : 0;
    const limit = Math.min(limitStr ? parseInt(limitStr, 10) : 20, 100); // Max 100 per page

    // Validate skip and limit are non-negative integers
    if (isNaN(skip) || skip < 0) {
      throw new BadRequestError('skip must be a non-negative integer');
    }
    if (isNaN(limit) || limit < 1) {
      throw new BadRequestError('limit must be a positive integer');
    }

    // Validate status if provided
    if (status && !Object.values(WebhookDeliveryStatus).includes(status)) {
      throw new BadRequestError('Invalid status value');
    }

    // If subscriptionId provided, verify user owns it
    if (subscriptionId) {
      const subscription = await webhookSubscriptionRepository.findById(subscriptionId);
      if (!subscription || subscription.userId !== user.id) {
        throw new BadRequestError('Subscription not found');
      }
    }

    // Parse since date if provided
    let sinceDate: Date | undefined;
    if (since) {
      sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        throw new BadRequestError('Invalid since date');
      }
    }

    // Query deliveries - always filter by userId for security
    const [deliveries, total] = await Promise.all([
      webhookDeliveryRepository.findByUserPaginated(user.id, {
        skip,
        limit,
        status,
        subscriptionId,
        since: sinceDate,
      }),
      webhookDeliveryRepository.countByUser(user.id, {
        status,
        subscriptionId,
        since: sinceDate,
      }),
    ]);

    const response: DeliveryListResponse = {
      deliveries,
      pagination: {
        skip,
        limit,
        total,
        hasMore: skip + deliveries.length < total,
      },
    };

    return res.status(200).json(response);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
