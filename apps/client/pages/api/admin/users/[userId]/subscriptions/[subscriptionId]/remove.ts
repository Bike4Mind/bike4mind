import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { IMongoDocument } from '@bike4mind/common';
import { entitlementsForPriceIds } from '@client/lib/entitlements/registry';
import { SubscriptionOwnerType, ISubscription } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';

interface RequestQuery {
  userId: string;
  subscriptionId: string;
}

const handler = baseApi().delete(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId, subscriptionId } = req.query as RequestQuery;

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
    const subscription = (await subscriptionRepository.findByStripeSubscriptionId(subscriptionId)) as
      | (ISubscription & IMongoDocument)
      | null;

    if (!subscription) {
      throw new NotFoundError('Subscription not found');
    }

    // Handle individual (user) subscription
    if (subscription.ownerType === SubscriptionOwnerType.User) {
      // Verify subscription belongs to the requested user
      if (subscription.ownerId !== userId) {
        throw new ForbiddenError('Subscription does not belong to the specified user');
      }

      if (!subscription.id) {
        throw new NotFoundError('Subscription ID not found');
      }

      await withTransaction(async () => {
        // Delete the subscription using the repository's delete method
        await subscriptionRepository.delete(subscription.id);

        req.logger.info(`Admin ${req.user.id} removed individual subscription ${subscriptionId} from user ${userId}`, {
          subscriptionId,
          userId,
        });
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

      // This removal deletes the row directly, bypassing Stripe - no webhook
      // will fire for it - so any subscription-derived entitlement revocation
      // must wake the gate from here. (Individual admin-grant rows carry no
      // subscriptionId and are not reachable via this route's Stripe-id
      // lookup - pre-existing behavior.)
      if (entitlementsForPriceIds([subscription.priceId]).size > 0) {
        await sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['entitlements'],
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Individual subscription removed successfully',
      });
    }

    // Handle team/organization subscription
    if (subscription.ownerType === SubscriptionOwnerType.Organization) {
      // This is a team subscription
      const organization = await organizationRepository.findById(subscription.ownerId);
      if (!organization) {
        throw new NotFoundError('Organization not found for this subscription');
      }

      if (!subscription.id) {
        throw new NotFoundError('Subscription ID not found');
      }

      await withTransaction(async () => {
        // Delete the subscription using the repository's delete method
        await subscriptionRepository.delete(subscription.id);

        req.logger.info(
          `Admin ${req.user.id} removed team subscription ${subscriptionId} from organization ${organization.id}`,
          {
            subscriptionId,
            organizationId: organization.id,
            userId,
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
        message: 'Team subscription removed successfully',
      });
    }

    // Subscription not found
    throw new NotFoundError('Subscription not found');
  })
);

export default handler;
