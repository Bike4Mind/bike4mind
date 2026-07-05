import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';
import { z } from 'zod';

const UpdateCreditsSchema = z.object({
  creditsPerCycle: z.int().positive(),
});

interface RequestQuery {
  userId: string;
  subscriptionId: string;
}

const handler = baseApi().put(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId, subscriptionId } = req.query as RequestQuery;
    const { creditsPerCycle } = UpdateCreditsSchema.parse(req.body);

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

    // Handle individual (user) subscription
    if (subscription.ownerType === SubscriptionOwnerType.User) {
      // This is an individual subscription - update customCreditsPerCycle
      await withTransaction(async () => {
        await subscriptionRepository.updateByStripeSubscriptionId(subscriptionId, {
          customCreditsPerCycle: creditsPerCycle,
        });

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
        message: `Successfully updated subscription credits to ${creditsPerCycle.toLocaleString()} per billing cycle`,
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

      await withTransaction(async () => {
        await subscriptionRepository.updateByStripeSubscriptionId(subscriptionId, {
          customCreditsPerCycle: creditsPerCycle,
        });

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
        message: `Successfully updated subscription credits to ${creditsPerCycle.toLocaleString()} per billing cycle for organization ${organization.name}`,
        creditsPerCycle,
      });
    }

    // Subscription not found
    throw new NotFoundError('Subscription not found');
  })
);

export default handler;
