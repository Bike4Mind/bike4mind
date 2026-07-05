/**
 * Jira Webhook Subscription API - Individual Subscription
 *
 * Allows users to get, update, or delete a specific subscription.
 *
 * @route GET /api/webhooks/jira/subscriptions/[id] - Get subscription
 * @route PUT /api/webhooks/jira/subscriptions/[id] - Update subscription
 * @route DELETE /api/webhooks/jira/subscriptions/[id] - Delete subscription
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { jiraWebhookConfigRepository, jiraWebhookSubscriptionRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { IJiraWebhookSubscriptionRequest, IJiraWebhookSubscriptionResponse } from '@bike4mind/common';
import { validateFilters } from '@server/integrations/jira/types';

const handler = baseApi()
  // GET - Get subscription
  .get(
    asyncHandler<object, IJiraWebhookSubscriptionResponse, unknown, { id?: string }>(async (req, res) => {
      const user = req.user!;
      const subscriptionId = req.query.id;

      if (!subscriptionId) {
        throw new BadRequestError('Subscription ID is required');
      }

      const subscription = await jiraWebhookSubscriptionRepository.findById(subscriptionId);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      // Only the owner can view
      if (subscription.userId !== user.id && !user.isAdmin) {
        throw new UnauthorizedError('You do not have access to this subscription');
      }

      const config = await jiraWebhookConfigRepository.findById(subscription.webhookConfigId);

      const response: IJiraWebhookSubscriptionResponse = {
        id: subscription.id,
        userId: subscription.userId,
        webhookConfigId: subscription.webhookConfigId,
        atlassianCloudId: subscription.atlassianCloudId,
        slackTarget: subscription.slackTarget,
        projectFilter: subscription.projectFilter,
        priorityFilter: subscription.priorityFilter,
        issueTypeFilter: subscription.issueTypeFilter,

        name: subscription.name,
        enabled: subscription.enabled,
        consecutiveFailures: subscription.consecutiveFailures,
        circuitBreakerOpenedAt: subscription.circuitBreakerOpenedAt,
        autoDisabledAt: subscription.autoDisabledAt,
        autoDisabledReason: subscription.autoDisabledReason,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
        atlassianSiteName: config?.atlassianSiteUrl,
      };

      return res.status(200).json(response);
    })
  )
  // PUT - Update subscription
  .put(
    asyncHandler<object, IJiraWebhookSubscriptionResponse, Partial<IJiraWebhookSubscriptionRequest>, { id?: string }>(
      async (req, res) => {
        const user = req.user!;
        const subscriptionId = req.query.id;

        if (!subscriptionId) {
          throw new BadRequestError('Subscription ID is required');
        }

        const subscription = await jiraWebhookSubscriptionRepository.findById(subscriptionId);
        if (!subscription) {
          throw new NotFoundError('Subscription not found');
        }

        // Only the owner can update
        if (subscription.userId !== user.id && !user.isAdmin) {
          throw new UnauthorizedError('You do not have access to this subscription');
        }

        const { slackTarget, projectFilter, priorityFilter, issueTypeFilter, name, enabled } = req.body || {};

        const updates: Record<string, unknown> = {};

        if (slackTarget !== undefined) {
          if (slackTarget.type === 'channel') {
            if (!slackTarget.channelId) {
              throw new BadRequestError('channelId is required for channel Slack target');
            }
          } else if (slackTarget.type === 'dm') {
            // DM target uses the user's linked Slack account - no extra fields needed
          } else {
            throw new BadRequestError('slackTarget.type must be "channel" or "dm"');
          }
          updates.slackTarget = slackTarget;
        }

        if (projectFilter !== undefined) {
          if (!Array.isArray(projectFilter)) {
            throw new BadRequestError('projectFilter must be an array');
          }
          updates.projectFilter = projectFilter;
        }

        if (priorityFilter !== undefined) {
          if (!Array.isArray(priorityFilter)) {
            throw new BadRequestError('priorityFilter must be an array');
          }
          updates.priorityFilter = priorityFilter;
        }

        if (issueTypeFilter !== undefined) {
          if (!Array.isArray(issueTypeFilter)) {
            throw new BadRequestError('issueTypeFilter must be an array');
          }
          updates.issueTypeFilter = issueTypeFilter;
        }

        // Validate filter values (after array checks, before saving)
        const filterError = validateFilters({
          projectFilter: updates.projectFilter as string[] | undefined,
          priorityFilter: updates.priorityFilter as string[] | undefined,
          issueTypeFilter: updates.issueTypeFilter as string[] | undefined,
        });
        if (filterError) {
          throw new BadRequestError(filterError);
        }

        if (name !== undefined) {
          updates.name = name;
        }

        if (enabled !== undefined) {
          updates.enabled = enabled;
          // If re-enabling, reset circuit breaker
          if (enabled && subscription.autoDisabledAt) {
            updates.consecutiveFailures = 0;
            updates.autoDisabledAt = null;
            updates.autoDisabledReason = null;
            updates.circuitBreakerOpenedAt = null;
          }
        }

        if (Object.keys(updates).length === 0) {
          throw new BadRequestError('No valid fields to update');
        }

        const updatedSubscription = await jiraWebhookSubscriptionRepository.update({
          ...subscription,
          ...updates,
        });

        if (!updatedSubscription) {
          throw new Error('Failed to update subscription');
        }

          const config = await jiraWebhookConfigRepository.findById(updatedSubscription.webhookConfigId);

        const response: IJiraWebhookSubscriptionResponse = {
          id: updatedSubscription.id,
          userId: updatedSubscription.userId,
          webhookConfigId: updatedSubscription.webhookConfigId,
          atlassianCloudId: updatedSubscription.atlassianCloudId,
          slackTarget: updatedSubscription.slackTarget,
          projectFilter: updatedSubscription.projectFilter,
          priorityFilter: updatedSubscription.priorityFilter,
          issueTypeFilter: updatedSubscription.issueTypeFilter,

          name: updatedSubscription.name,
          enabled: updatedSubscription.enabled,
          consecutiveFailures: updatedSubscription.consecutiveFailures,
          circuitBreakerOpenedAt: updatedSubscription.circuitBreakerOpenedAt,
          autoDisabledAt: updatedSubscription.autoDisabledAt,
          autoDisabledReason: updatedSubscription.autoDisabledReason,
          createdAt: updatedSubscription.createdAt,
          updatedAt: updatedSubscription.updatedAt,
          atlassianSiteName: config?.atlassianSiteUrl,
        };

        return res.status(200).json(response);
      }
    )
  )
  // DELETE - Delete subscription
  .delete(
    asyncHandler<object, { success: boolean; message: string }, unknown, { id?: string }>(async (req, res) => {
      const user = req.user!;
      const subscriptionId = req.query.id;

      if (!subscriptionId) {
        throw new BadRequestError('Subscription ID is required');
      }

      const subscription = await jiraWebhookSubscriptionRepository.findById(subscriptionId);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      // Only the owner can delete
      if (subscription.userId !== user.id && !user.isAdmin) {
        throw new UnauthorizedError('You do not have access to this subscription');
      }

      await jiraWebhookSubscriptionRepository.delete(subscriptionId);

      return res.status(200).json({
        success: true,
        message: 'Subscription deleted successfully',
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
