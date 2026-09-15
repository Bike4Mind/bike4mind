/**
 * User Webhook Subscription API
 *
 * Allows users to subscribe to organization-level GitHub webhooks.
 * Users must be members of the organization to subscribe.
 *
 * Security:
 * - User must be an organization member to subscribe
 * - All queries include userId for IDOR protection (defense-in-depth)
 * - Repos must be subset of org config repos
 * - Subscriber cap enforced (max 500 per org)
 *
 * @route POST /api/webhooks/github/subscriptions - Create subscription
 * @route GET /api/webhooks/github/subscriptions - List user's subscriptions
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

// Maximum subscribers per organization to prevent fan-out amplification
const MAX_SUBSCRIBERS_PER_ORG = 500;

/**
 * Verify user is a member of the organization
 */
async function verifyOrgMembership(userId: string, orgId: string, isAdmin: boolean) {
  // Admin users have access to all organizations
  if (isAdmin) {
    const org = await organizationRepository.findById(orgId);
    if (!org) {
      throw new NotFoundError('Organization not found');
    }
    return org;
  }

  // For regular users, check if they are a member of the organization
  const org = await organizationRepository.findById(orgId);
  if (!org) {
    throw new NotFoundError('Organization not found');
  }

  // Check if user is owner, manager, or in the users array
  const isOwner = org.userId === userId;
  const isManager = org.managerId === userId;
  const isMember = org.users?.some(u => u.userId === userId);

  if (!isOwner && !isManager && !isMember) {
    // Return same error for not found and not authorized (prevent enumeration)
    throw new NotFoundError('Organization not found');
  }

  return org;
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
  // POST - Create subscription to organization webhook
  .post(
    asyncHandler<{}, IWebhookSubscriptionResponse, IWebhookSubscriptionRequest>(async (req, res) => {
      const user = req.user!;
      const { organizationId, repos = [], events = [], mcpServerId, enabled = true } = req.body || {};

      if (!organizationId) {
        throw new BadRequestError('organizationId is required');
      }

      const org = await verifyOrgMembership(user.id, organizationId, user.isAdmin);

      const orgConfig = await orgWebhookConfigRepository.findByOrganizationId(organizationId);
      if (!orgConfig) {
        throw new BadRequestError('Organization has no webhook configuration. Please contact your admin.');
      }

      if (!orgConfig.enabled) {
        throw new BadRequestError('Organization webhook is currently disabled.');
      }

      const subscriberCount = await webhookSubscriptionRepository.countByOrganization(organizationId);
      if (subscriberCount >= MAX_SUBSCRIBERS_PER_ORG) {
        throw new BadRequestError(
          `Organization has reached maximum subscriber limit (${MAX_SUBSCRIBERS_PER_ORG}). ` +
            'Please contact your admin.'
        );
      }

      const existingSubscription = await webhookSubscriptionRepository.findByUserAndOrg(user.id, organizationId);
      if (existingSubscription) {
        throw new BadRequestError('You already have a subscription for this organization');
      }

      // Validate repos are subset of org config repos (if org has specific repos)
      if (repos.length > 0 && orgConfig.repos.length > 0) {
        const invalidRepos = repos.filter(r => !orgConfig.repos.includes(r));
        if (invalidRepos.length > 0) {
          // Generic error to prevent info disclosure about allowed repos
          throw new BadRequestError('One or more repositories are not available for subscription');
        }
      }

      // Validate events are subset of org config events (if org has specific events)
      if (events.length > 0 && orgConfig.subscribedEvents.length > 0) {
        const invalidEvents = events.filter(e => !orgConfig.subscribedEvents.includes(e));
        if (invalidEvents.length > 0) {
          // Generic error to prevent info disclosure about allowed events
          throw new BadRequestError('One or more event types are not available for subscription');
        }
      }

      const subscription = await webhookSubscriptionRepository.create({
        userId: user.id,
        organizationId,
        repos,
        events,
        mcpServerId,
        enabled,
      });

      const response = formatSubscriptionResponse(subscription, org.name);

      return res.status(201).json(response);
    })
  )
  // GET - List user's subscriptions
  .get(
    asyncHandler<{}, IWebhookSubscriptionResponse[]>(async (req, res) => {
      const user = req.user!;

      // Find all subscriptions for this user (defense-in-depth: always filter by userId)
      const subscriptions = await webhookSubscriptionRepository.findByUserId(user.id);

      // Enrich with organization names
      const responses: IWebhookSubscriptionResponse[] = await Promise.all(
        subscriptions.map(async sub => {
          const org = await organizationRepository.findById(sub.organizationId);
          return formatSubscriptionResponse(sub, org?.name);
        })
      );

      return res.status(200).json(responses);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
