/**
 * Jira Webhook Subscriptions API
 *
 * Allows users to create and list their Jira webhook subscriptions.
 * Each subscription determines which events are sent to which Slack channel.
 *
 * @route POST /api/webhooks/jira/subscriptions - Create subscription
 * @route GET /api/webhooks/jira/subscriptions - List user's subscriptions
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { jiraWebhookConfigRepository, jiraWebhookSubscriptionRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { IJiraWebhookSubscriptionRequest, IJiraWebhookSubscriptionResponse } from '@bike4mind/common';
import { AtlassianTokenManager } from '@server/integrations/jira/atlassianTokenManager';
import { validateFilters } from '@server/integrations/jira/types';

const handler = baseApi()
  // POST - Create subscription
  .post(
    asyncHandler<object, IJiraWebhookSubscriptionResponse, IJiraWebhookSubscriptionRequest>(async (req, res) => {
      const user = req.user!;

      const tokens = await AtlassianTokenManager.getValidTokens(user.id);
      if (!tokens) {
        throw new UnauthorizedError('Atlassian connection not found. Please connect your Atlassian account first.');
      }

      const { cloudId } = tokens;

      const {
        webhookConfigId,
        slackTarget,
        projectFilter = [],
        priorityFilter = [],
        issueTypeFilter = [],
        name,
        enabled = true,
      } = req.body || {};

      if (!webhookConfigId) {
        throw new BadRequestError('webhookConfigId is required');
      }

      if (!slackTarget) {
        throw new BadRequestError('slackTarget is required');
      }

      if (slackTarget.type === 'channel') {
        if (!slackTarget.channelId) {
          throw new BadRequestError('channelId is required for channel Slack target');
        }
      } else if (slackTarget.type === 'dm') {
        // DM target uses the user's linked Slack account - no extra fields needed
      } else {
        throw new BadRequestError('slackTarget.type must be "channel" or "dm"');
      }

      const filterError = validateFilters({ projectFilter, priorityFilter, issueTypeFilter });
      if (filterError) {
        throw new BadRequestError(filterError);
      }

      const webhookConfig = await jiraWebhookConfigRepository.findById(webhookConfigId);
      if (!webhookConfig) {
        throw new NotFoundError('Webhook configuration not found');
      }

      // Verify user's Atlassian cloud matches the config
      if (webhookConfig.atlassianCloudId !== cloudId) {
        throw new UnauthorizedError('This webhook configuration belongs to a different Atlassian site');
      }

      const existingSubscription = await jiraWebhookSubscriptionRepository.findByUserAndConfig(
        user.id,
        webhookConfigId
      );
      if (existingSubscription) {
        throw new BadRequestError('You already have a subscription for this webhook configuration');
      }

      const subscription = await jiraWebhookSubscriptionRepository.create({
        userId: user.id,
        webhookConfigId,
        atlassianCloudId: cloudId,
        slackTarget,
        projectFilter,
        priorityFilter,
        issueTypeFilter,
        name,
        enabled,
      });

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
        atlassianSiteName: webhookConfig.atlassianSiteUrl,
      };

      return res.status(201).json(response);
    })
  )
  // GET - List user's subscriptions
  .get(
    asyncHandler<object, IJiraWebhookSubscriptionResponse[]>(async (req, res) => {
      const user = req.user!;

      const subscriptions = await jiraWebhookSubscriptionRepository.findByUserId(user.id);

      const configIds = [...new Set(subscriptions.map(s => s.webhookConfigId))];
      const configMap = new Map<string, string>();

      for (const configId of configIds) {
        const config = await jiraWebhookConfigRepository.findById(configId);
        if (config) {
          configMap.set(configId, config.atlassianSiteUrl);
        }
      }

      const response: IJiraWebhookSubscriptionResponse[] = subscriptions.map(subscription => ({
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
        atlassianSiteName: configMap.get(subscription.webhookConfigId),
      }));

      return res.status(200).json(response);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
