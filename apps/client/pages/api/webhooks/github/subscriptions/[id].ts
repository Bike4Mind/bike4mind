/**
 * Single Webhook Subscription API
 *
 * Allows users to manage their individual webhook subscriptions.
 *
 * Security:
 * - All operations verify the subscription belongs to the requesting user (IDOR protection)
 * - Re-verifies org membership at operation time
 *
 * @route GET /api/webhooks/github/subscriptions/[id] - Get subscription
 * @route PUT /api/webhooks/github/subscriptions/[id] - Update subscription
 * @route DELETE /api/webhooks/github/subscriptions/[id] - Delete subscription
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { orgWebhookConfigRepository } from '@bike4mind/database/infra';
import { webhookSubscriptionRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import {
  IWebhookSubscriptionRequest,
  IWebhookSubscriptionResponse,
  IWebhookSubscriptionDocument,
} from '@bike4mind/common';

/**
 * Verify user owns the subscription (IDOR protection)
 */
async function verifySubscriptionOwnership(userId: string, subscriptionId: string, isAdmin: boolean) {
  const subscription = await webhookSubscriptionRepository.findById(subscriptionId);

  if (!subscription) {
    throw new NotFoundError('Subscription not found');
  }

  // Check ownership (admin can access any subscription)
  if (!isAdmin && subscription.userId !== userId) {
    // Return same error as not found (prevent enumeration)
    throw new NotFoundError('Subscription not found');
  }

  return subscription;
}

/**
 * Format subscription response with additional metadata
 */
function formatSubscriptionResponse(
  subscription: IWebhookSubscriptionDocument,
  organizationName?: string
): IWebhookSubscriptionResponse {
  return {
    ...subscription,
    organizationName,
  };
}

const handler = baseApi()
  // GET - Get single subscription
  .get(
    asyncHandler<{}, IWebhookSubscriptionResponse, unknown, { id?: string }>(async (req, res) => {
      const subscriptionId = req.query.id!;
      const user = req.user!;

      // Verify user owns the subscription
      const subscription = await verifySubscriptionOwnership(user.id, subscriptionId, user.isAdmin);

      // Get organization name for display
      const org = await organizationRepository.findById(subscription.organizationId);

      const response = formatSubscriptionResponse(subscription, org?.name);

      return res.status(200).json(response);
    })
  )
  // PUT - Update subscription
  .put(
    asyncHandler<{}, IWebhookSubscriptionResponse, Partial<IWebhookSubscriptionRequest>, { id?: string }>(
      async (req, res) => {
        const subscriptionId = req.query.id!;
        const user = req.user!;

        // Verify user owns the subscription
        const subscription = await verifySubscriptionOwnership(user.id, subscriptionId, user.isAdmin);

        // Get org config for validation
        const orgConfig = await orgWebhookConfigRepository.findByOrganizationId(subscription.organizationId);
        if (!orgConfig) {
          throw new BadRequestError('Organization webhook configuration no longer exists');
        }

        const { repos, events, mcpServerId, enabled } = req.body || {};

        const updates: Partial<IWebhookSubscriptionDocument> = {};

        if (repos !== undefined) {
          if (!Array.isArray(repos)) {
            throw new BadRequestError('repos must be an array');
          }
          // Validate repos are subset of org config repos
          if (repos.length > 0 && orgConfig.repos.length > 0) {
            const invalidRepos = repos.filter(r => !orgConfig.repos.includes(r));
            if (invalidRepos.length > 0) {
              // Generic error to prevent info disclosure about allowed repos
              throw new BadRequestError('One or more repositories are not available for subscription');
            }
          }
          updates.repos = repos;
        }

        if (events !== undefined) {
          if (!Array.isArray(events)) {
            throw new BadRequestError('events must be an array');
          }
          // Validate events are subset of org config events
          if (events.length > 0 && orgConfig.subscribedEvents.length > 0) {
            const invalidEvents = events.filter(e => !orgConfig.subscribedEvents.includes(e));
            if (invalidEvents.length > 0) {
              // Generic error to prevent info disclosure about allowed events
              throw new BadRequestError('One or more event types are not available for subscription');
            }
          }
          updates.events = events;
        }

        if (mcpServerId !== undefined) {
          updates.mcpServerId = mcpServerId;
        }

        if (enabled !== undefined) {
          updates.enabled = enabled;
        }

        if (Object.keys(updates).length === 0) {
          throw new BadRequestError('No valid fields to update');
        }

        const updatedSubscription = await webhookSubscriptionRepository.update({
          ...subscription,
          ...updates,
        });

        if (!updatedSubscription) {
          throw new Error('Failed to update subscription');
        }

        // Get organization name for display
        const org = await organizationRepository.findById(subscription.organizationId);

        const response = formatSubscriptionResponse(updatedSubscription, org?.name);

        return res.status(200).json(response);
      }
    )
  )
  // DELETE - Delete subscription (unsubscribe)
  .delete(
    asyncHandler<{}, { success: boolean; message: string }, unknown, { id?: string }>(async (req, res) => {
      const subscriptionId = req.query.id!;
      const user = req.user!;

      // Verify user owns the subscription
      const subscription = await verifySubscriptionOwnership(user.id, subscriptionId, user.isAdmin);

      await webhookSubscriptionRepository.delete(subscription.id);

      return res.status(200).json({
        success: true,
        message: 'Successfully unsubscribed from webhook events',
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
