import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';
import { z } from 'zod';

const UpdateCreditsSchema = z.object({
  // null clears the override, returning the subscription to its plan's own rate.
  creditsPerCycle: z.int().positive().nullable(),
});

interface RequestQuery {
  userId: string;
  subscriptionId: string;
}

// requiredScopes gates the API-key path only: apiKeyAuth 403s an under-scoped key
// before req.user is set, so a key issued for a narrow integration can't modify
// a subscription's credit rate just because its owner is an admin. JWT/browser
// admins skip that check and still pass the isAdmin gate below.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).put(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId, subscriptionId } = req.query as RequestQuery;
    const { creditsPerCycle } = UpdateCreditsSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid user ID');
    }

    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      throw new BadRequestError('Invalid subscription ID');
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Find subscription in unified Subscription model
    const subscription = await subscriptionRepository.findByStripeSubscriptionId(subscriptionId);

    if (!subscription) {
      throw new NotFoundError('Subscription not found');
    }
    if (creditsPerCycle === null && subscription.customCreditsPerCycle == null) {
      throw new BadRequestError('This subscription has no credits override to clear.');
    }

    // details.credits is the signed change in the effective per-cycle rate, derived as the admin
    // subscriptions listing derives it, so a raise counts toward the grant thresholds.
    // A null `creditsPerCycle` clears the override, so the new effective rate is the plan's own.
    const recordRateChange = (
      previousCreditsPerCycle: number,
      defaultCreditsPerCycle: number,
      organizationId?: string
    ) => {
      const effectiveCreditsPerCycle = creditsPerCycle ?? defaultCreditsPerCycle;
      return recordAdminActionFromRequest(req, {
        action: 'user.credits.adjusted',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        organizationId,
        summary:
          creditsPerCycle === null
            ? 'cleared the subscription credits override'
            : `set subscription credits to ${creditsPerCycle} per billing cycle`,
        reason,
        changes: [
          {
            field: 'customCreditsPerCycle',
            before: subscription.customCreditsPerCycle ?? null,
            after: creditsPerCycle,
          },
        ],
        details: {
          credits: effectiveCreditsPerCycle - previousCreditsPerCycle,
          subscriptionId,
          previousCreditsPerCycle,
          creditsPerCycle: effectiveCreditsPerCycle,
        },
      });
    };

    const writeRate = async () => {
      if (creditsPerCycle === null) await subscriptionRepository.clearCustomCreditsPerCycle(subscriptionId);
      else
        await subscriptionRepository.updateByStripeSubscriptionId(subscriptionId, {
          customCreditsPerCycle: creditsPerCycle,
        });
    };
    const rateLabel = creditsPerCycle === null ? 'the plan default' : creditsPerCycle.toLocaleString();

    // Handle individual (user) subscription
    if (subscription.ownerType === SubscriptionOwnerType.User) {
      const defaultCreditsPerCycle = SUBSCRIPTION_PLANS_MAP[subscription.priceId]?.credits ?? 0;
      const previousCreditsPerCycle = subscription.customCreditsPerCycle ?? defaultCreditsPerCycle;

      // This is an individual subscription - update customCreditsPerCycle
      await withTransaction(async () => {
        await writeRate();
        await recordRateChange(previousCreditsPerCycle, defaultCreditsPerCycle);

        req.logger.info(
          `Admin ${req.user.id} set customCreditsPerCycle to ${creditsPerCycle} for individual subscription ${subscriptionId} (user ${userId})`,
          {
            subscriptionId,
            userId,
            creditsPerCycle,
          }
        );
      });

      // Notify user
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['subscriptions'],
      });
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['admin', 'user-subscriptions', userId],
      });

      return res.status(200).json({
        success: true,
        message: `Successfully updated subscription credits to ${rateLabel} per billing cycle`,
        creditsPerCycle,
      });
    }

    // Handle team/organization subscription
    if (subscription.ownerType === SubscriptionOwnerType.Organization) {
      // This is a team subscription - update customCreditsPerCycle
      const organization = await organizationRepository.findById(subscription.ownerId);
      if (!organization) {
        throw new NotFoundError('Organization not found for this subscription');
      }

      if (!subscription.id) {
        throw new NotFoundError('Subscription ID not found');
      }

      const defaultCreditsPerCycle = subscription.quantity * (await getTeamPlanSettings()).creditsPerSeat;
      const previousCreditsPerCycle = subscription.customCreditsPerCycle ?? defaultCreditsPerCycle;

      await withTransaction(async () => {
        await writeRate();
        await recordRateChange(previousCreditsPerCycle, defaultCreditsPerCycle, organization.id);

        req.logger.info(
          `Admin ${req.user.id} set customCreditsPerCycle to ${creditsPerCycle} for team subscription ${subscriptionId} (organization ${organization.id})`,
          {
            subscriptionId,
            organizationId: organization.id,
            userId,
            creditsPerCycle,
          }
        );
      });

      // Notify relevant users
      const promises: Promise<void>[] = [];

      const orgUsers = organization.users;
      if (orgUsers && Array.isArray(orgUsers) && orgUsers.length > 0) {
        const userNotifications = orgUsers
          .filter((orgUser: any) => orgUser && orgUser.userId)
          .map((orgUser: any) =>
            sendToClient(orgUser.userId, Resource.websocket.managementEndpoint, {
              action: 'invalidate_query',
              queryKey: ['subscriptions'],
            })
          );
        promises.push(...userNotifications);
      }

      promises.push(
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['subscriptions'],
        }),
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['organizations'],
        }),
        sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['admin', 'user-subscriptions', userId],
        })
      );

      await Promise.all(promises);

      return res.status(200).json({
        success: true,
        message: `Successfully updated subscription credits to ${rateLabel} per billing cycle for organization ${organization.name}`,
        creditsPerCycle,
      });
    }

    // Subscription not found
    throw new NotFoundError('Subscription not found');
  })
);

export default handler;
