import {
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { organizationService, creditService } from '@bike4mind/services';
import { CreditHolderType, IOrganizationDocument } from '@bike4mind/common';
import {
  ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT,
  ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { entitlementsForPriceIds } from '@client/lib/entitlements/registry';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { dayjs } from '@bike4mind/common';
import { z } from 'zod';
import { Resource } from 'sst';
import { randomUUID } from 'crypto';

const GrantSubscriptionSchema = z.object({
  subscriptionType: z.enum(['individual', 'team']),
  priceId: z.string().optional(), // For individual subscriptions
  seats: z.number().min(ORGANIZATION_SUBSCRIPTION_MIN_SEATS).optional(), // For team subscriptions
  organizationName: z.string().optional(), // For new team subscriptions
  organizationId: z.string().optional(), // For existing team subscriptions
  durationMonths: z.number().min(1).max(12).prefault(1), // How many months to grant
  billingOwnerId: z.string().optional(), // User ID of the billing owner (maps to organization.userId)
  managerId: z.string().optional(), // User ID of the team manager
});

interface RequestQuery {
  userId: string;
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    // Check admin authorization
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { userId } = req.query as RequestQuery;
    const {
      subscriptionType,
      priceId,
      seats = ORGANIZATION_SUBSCRIPTION_MIN_SEATS,
      organizationName,
      organizationId,
      durationMonths,
      billingOwnerId,
      managerId,
    } = GrantSubscriptionSchema.parse(req.body);

    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestError('Invalid user ID');
    }

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    const now = dayjs();
    const periodStartsAt = now.toDate();
    const periodEndsAt = now.add(durationMonths, 'months').toDate();

    if (subscriptionType === 'individual') {
      if (!priceId) {
        throw new BadRequestError('Price ID required for individual subscriptions');
      }

      const planDetail = SUBSCRIPTION_PLANS.find(plan => plan.priceId === priceId);
      if (!planDetail) {
        throw new BadRequestError('Invalid subscription plan');
      }

      // Check for existing active subscription
      const existingSubscription = await subscriptionRepository.findUserSubscriptionByPriceId(priceId, userId);
      if (existingSubscription && existingSubscription.status === 'active') {
        throw new BadRequestError('User already has an active subscription for this plan');
      }

      await withTransaction(async () => {
        // Create subscription record in unified Subscription model
        await subscriptionRepository.create({
          ownerType: SubscriptionOwnerType.User,
          ownerId: user.id,
          // Sentinel id for admin grants - not a Stripe subscription, but the
          // unique index on subscriptionId is non-sparse (DocumentDB constraint),
          // so every row needs a real value (mirrors organizations/grant.ts).
          subscriptionId: `admin_grant_${randomUUID()}`,
          priceId: priceId,
          status: 'active',
          source: SubscriptionSource.AdminGrant,
          grantedBy: req.user.id,
          periodStartsAt,
          periodEndsAt,
          quantity: 1, // Always 1 for individual subscriptions (not team seats)
          canceledAt: null,
        });

        // Add credits to user
        const creditsToAdd = planDetail.credits * durationMonths;
        await creditService.addCredits(
          {
            ownerId: user.id,
            ownerType: CreditHolderType.User,
            credits: creditsToAdd,
            type: 'subscription',
            metadata: {},
          },
          {
            db: {
              creditTransactions: creditTransactionRepository,
            },
            creditHolderMethods: userRepository,
          }
        );

        req.logger.info(`Admin ${req.user.id} granted individual subscription to user ${userId}`, {
          priceId,
          credits: creditsToAdd,
          durationMonths,
        });
      });

      await logAuditEvent(
        {
          userId,
          action: AdminOrgAuditEvents.ORG_GRANTED,
          adminUserId: req.user.id,
          adminUsername: req.user.username,
          metadata: {
            subscriptionType: 'individual',
            priceId,
            credits: planDetail.credits * durationMonths,
            durationMonths,
          },
        },
        req.logger
      );

      // Notify user
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['subscriptions'],
      });

      // Admin grants never produce a Stripe webhook, so the entitlement gate
      // must be woken here when the granted price maps to entitlement keys.
      if (entitlementsForPriceIds([priceId]).size > 0) {
        await sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['entitlements'],
        });
      }

      return res.status(200).json({
        success: true,
        message: `Individual subscription granted for ${durationMonths} month(s)`,
        credits: planDetail.credits * durationMonths,
      });
    } else if (subscriptionType === 'team') {
      if (!organizationName && !organizationId) {
        throw new BadRequestError('Organization name or ID required for team subscriptions');
      }

      // Get or create organization first
      let targetOrganization: IOrganizationDocument;

      if (organizationId) {
        // Use existing organization
        const existingOrg = await organizationRepository.findById(organizationId);
        if (!existingOrg) {
          throw new NotFoundError('Organization not found');
        }

        // Check if user is already in the organization
        const isOwner = existingOrg.userId === userId;
        const hasUsers = existingOrg.users && Array.isArray(existingOrg.users);
        const isMember = hasUsers ? existingOrg.users.some((u: any) => u.userId === userId) : false;

        if (!isOwner && !isMember) {
          throw new BadRequestError('User is not a member of this organization');
        }

        targetOrganization = existingOrg;
      } else {
        // Create new organization
        targetOrganization = await organizationService.create(
          user,
          {
            name: organizationName!,
            seats: seats,
            personal: false,
            stripeCustomerId: null, // Admin granted subscriptions don't need Stripe customer
            billingOwnerId: billingOwnerId, // Optional billing owner
            managerId: managerId, // Optional team manager
          },
          {
            db: {
              organizations: organizationRepository,
            },
          }
        );
      }

      // Now handle the subscription creation within transaction
      await withTransaction(async () => {
        // Check for existing active team subscription
        const existingSubscription = await subscriptionRepository.findByPriceIdAndOwner(
          ORGANIZATION_SUBSCRIPTION_PRICE_ID,
          SubscriptionOwnerType.Organization,
          targetOrganization.id
        );

        if (existingSubscription && existingSubscription.status === 'active') {
          throw new BadRequestError('Organization already has an active team subscription');
        }

        // Create subscription record
        await subscriptionRepository.create({
          ownerType: SubscriptionOwnerType.Organization,
          ownerId: targetOrganization.id,
          // Sentinel id for admin grants - not a Stripe subscription, but the
          // unique index on subscriptionId is non-sparse (DocumentDB constraint),
          // so every row needs a real value (mirrors organizations/grant.ts).
          subscriptionId: `admin_grant_${randomUUID()}`,
          priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
          status: 'active',
          source: SubscriptionSource.AdminGrant,
          grantedBy: req.user.id,
          periodStartsAt,
          periodEndsAt,
          canceledAt: null,
          quantity: seats,
        });

        // Add credits to organization
        const creditsToAdd = seats * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT * durationMonths;
        await creditService.addCredits(
          {
            ownerId: targetOrganization.id,
            ownerType: CreditHolderType.Organization,
            credits: creditsToAdd,
            type: 'subscription',
            metadata: {},
          },
          {
            db: {
              creditTransactions: creditTransactionRepository,
            },
            creditHolderMethods: organizationRepository,
          }
        );

        // Update organization seats if needed
        if (targetOrganization.seats < seats) {
          targetOrganization.seats = seats;
          await organizationRepository.update(targetOrganization);
        }

        req.logger.info(`Admin ${req.user.id} granted team subscription to organization ${targetOrganization.id}`, {
          seats,
          credits: creditsToAdd,
          durationMonths,
          userId,
        });
      });

      await logAuditEvent(
        {
          userId: targetOrganization.userId,
          action: AdminOrgAuditEvents.ORG_GRANTED,
          adminUserId: req.user.id,
          adminUsername: req.user.username,
          metadata: {
            subscriptionType: 'team',
            organizationId: targetOrganization.id,
            seats,
            credits: seats * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT * durationMonths,
            durationMonths,
          },
        },
        req.logger
      );

      // Notify relevant users. (No ['entitlements'] push here: entitlement
      // resolution is User-owned only - when the org-seat fast-follow lands
      // (ACCESS_MODEL §3.2), it must add a seat-holder fan-out for mapped
      // prices alongside these pushes.)
      const promises: Promise<void>[] = [];

      // Check if organization has users array and if it's populated
      const orgUsers = targetOrganization.users;
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
        })
      );

      await Promise.all(promises);

      return res.status(200).json({
        success: true,
        message: `Team subscription granted for ${durationMonths} month(s)`,
        organizationId: targetOrganization.id,
        seats,
        credits: seats * ORGANIZATION_SUBSCRIPTION_CREDITS_PER_SEAT * durationMonths,
      });
    }

    throw new BadRequestError('Invalid subscription type');
  })
);

export default handler;
