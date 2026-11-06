import {
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { organizationService, creditService } from '@bike4mind/services';
import { type AdminApproval, ConflictError, CreditHolderType, IOrganizationDocument } from '@bike4mind/common';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@bike4mind/server-utils/lib/subscriptions/constants';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { priceAffectsEntitlements } from '@server/entitlements/paidStanding';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { grantIndividualAdminSubscription } from '@server/subscriptions/grantIndividualAdminSubscription';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { isSelfOrImpersonator, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { dayjs } from '@bike4mind/common';
import { z } from 'zod';
import { Resource } from 'sst';
import { randomUUID } from 'crypto';

import type { Request } from 'express';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { approvalDetails, notifyAfterCommit } from './approval';

export const GrantSubscriptionSchema = z.object({
  subscriptionType: z.enum(['individual', 'team']),
  priceId: z.string().optional(), // For individual subscriptions
  seats: z.number().int().optional(), // For team subscriptions; teamPlanMinSeats/teamPlanMaxSeats checked below
  organizationName: z.string().optional(), // For new team subscriptions
  organizationId: z.string().optional(), // For existing team subscriptions
  durationMonths: z.number().min(1).max(12).prefault(1), // How many months to grant
  billingOwnerId: z.string().optional(), // User ID of the billing owner (maps to organization.userId)
});

export const GrantSubscriptionParamsSchema = GrantSubscriptionSchema.extend({
  seats: z.number().int(),
  userId: z.string().min(1),
  reason: z.string(),
  /** Credits the grant came to when it was requested; a different figure at execute is a 409. */
  creditsAtRequest: z.number().optional(),
});
export type GrantSubscriptionParams = z.infer<typeof GrantSubscriptionParamsSchema>;
type TeamPlan = Awaited<ReturnType<typeof getTeamPlanSettings>>;

/** Credits the grant adds: plan credits for an individual grant, seats x per-seat for a team; 0 for an unknown plan. */
export function grantSubscriptionCredits(params: GrantSubscriptionParams, teamPlan: TeamPlan): number {
  const { subscriptionType, priceId, seats, durationMonths } = params;
  if (subscriptionType === 'team') return seats * teamPlan.creditsPerSeat * durationMonths;
  return (SUBSCRIPTION_PLANS.find(plan => plan.priceId === priceId)?.credits ?? 0) * durationMonths;
}

/** Seat bounds and target user, checked before a request is stored and again when it runs. */
export async function validateGrantSubscription({ seats, userId }: GrantSubscriptionParams, teamPlan: TeamPlan) {
  if (seats < teamPlan.minSeats) {
    throw new BadRequestError(`Team grants need at least ${teamPlan.minSeats} seats`);
  }
  if (seats > teamPlan.maxSeats) {
    throw new BadRequestError(`Seats cannot exceed ${teamPlan.maxSeats}`);
  }

  const user = await userRepository.findById(userId);
  if (!user) {
    throw new NotFoundError('User not found');
  }
  return user;
}

/** Grants the subscription as `req.user`; shared by the route and the approval executor. */
export async function grantSubscription(req: Request, params: GrantSubscriptionParams, approval?: AdminApproval) {
  const teamPlan = await getTeamPlanSettings();
  const {
    userId,
    subscriptionType,
    priceId,
    seats,
    organizationName,
    organizationId,
    durationMonths,
    billingOwnerId,
    reason,
  } = params;
  if (params.creditsAtRequest !== undefined && grantSubscriptionCredits(params, teamPlan) !== params.creditsAtRequest) {
    throw new ConflictError('The credits this grant adds changed since it was requested. Submit a new request.');
  }
  const selfGrant =
    isSelfOrImpersonator(req.user!, userId) || (approval?.requestedBy.selfIds.includes(userId) ?? false);
  const user = await validateGrantSubscription(params, teamPlan);

  const now = dayjs();
  const periodStartsAt = now.toDate();
  const periodEndsAt = now.add(durationMonths, 'months').toDate();

  if (subscriptionType === 'individual') {
    if (!priceId) {
      throw new BadRequestError('Price ID required for individual subscriptions');
    }

    const grant = await grantIndividualAdminSubscription({
      userId: user.id,
      priceId,
      durationMonths,
      grantedBy: req.user!.id,
      grantedReason: reason,
      onGranted: async ({ credits, creditTransactionId, subscriptionId }) => {
        await recordAdminActionFromRequest(req, {
          action: 'user.subscription.granted',
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
          summary: `granted individual subscription for ${durationMonths} month(s)`,
          reason,
          details: {
            ...approvalDetails(approval),
            subscriptionType: 'individual',
            priceId,
            credits,
            durationMonths,
            subscriptionId,
            selfGrant,
          },
          related: creditTransactionId ? { creditTransactionId } : undefined,
        });
      },
    });
    if (grant.status === 'unknown_plan') {
      throw new BadRequestError('Invalid subscription plan');
    }
    if (grant.status === 'already_active') {
      throw new BadRequestError('User already has an active subscription for this plan');
    }
    if (grant.status === 'already_granted') {
      throw new BadRequestError('This subscription grant already exists for this user');
    }

    req.logger.info(`Admin ${req.user!.id} granted individual subscription to user ${userId}`, {
      priceId,
      credits: grant.credits,
      durationMonths,
    });

    // Notify user
    await notifyAfterCommit(req, async () => {
      await sendToClient(userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['subscriptions'],
      });
      // Admin grants never produce a Stripe webhook, so the entitlement gate
      // must be woken here when the granted price maps to entitlement keys.
      if (priceAffectsEntitlements(priceId)) {
        await sendToClient(userId, Resource.websocket.managementEndpoint, {
          action: 'invalidate_query',
          queryKey: ['entitlements'],
        });
      }
    });

    return {
      success: true,
      message: `Individual subscription granted for ${durationMonths} month(s)`,
      credits: grant.credits,
      subscriptionRecordId: grant.subscriptionRecordId,
    };
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
        },
        {
          db: {
            organizations: organizationRepository,
            users: userRepository,
          },
          logger: req.logger,
        }
      );
    }

    const teamSubscriptionId = `admin_grant_${randomUUID()}`;
    let subscriptionRecordId = '';

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
      const created = await subscriptionRepository.create({
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: targetOrganization.id,
        // Sentinel id for admin grants - not a Stripe subscription, but the
        // unique index on subscriptionId is non-sparse (DocumentDB constraint),
        // so every row needs a real value (mirrors organizations/grant.ts).
        subscriptionId: teamSubscriptionId,
        priceId: ORGANIZATION_SUBSCRIPTION_PRICE_ID,
        status: 'active',
        source: SubscriptionSource.AdminGrant,
        grantedBy: req.user!.id,
        grantedReason: reason,
        periodStartsAt,
        periodEndsAt,
        canceledAt: null,
        quantity: seats,
      });
      subscriptionRecordId = String(created.id);

      // Add credits to organization
      const creditsToAdd = seats * teamPlan.creditsPerSeat * durationMonths;
      const { creditTransactionId } = await creditService.addCreditsWithLedgerRow(
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
            creditLots: creditLotRepository,
          },
          creditHolderMethods: organizationRepository,
          lotFundingSource: 'granted',
        }
      );

      // Update organization seats if needed. Targeted write: a whole-org snapshot
      // here would $set the pre-grant currentCredits back over the atomic $inc
      // addCredits just applied, erasing the credits granted above.
      if (targetOrganization.seats < seats) {
        await organizationRepository.update({ id: targetOrganization.id, seats });
      }

      await recordAdminActionFromRequest(req, {
        action: 'user.subscription.granted',
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username },
        organizationId: targetOrganization.id,
        summary: `granted team subscription with ${seats} seats for ${durationMonths} month(s)`,
        reason,
        details: {
          ...approvalDetails(approval),
          subscriptionType: 'team',
          seats,
          credits: creditsToAdd,
          durationMonths,
          organizationOwnerId: targetOrganization.userId,
          subscriptionId: teamSubscriptionId,
          selfGrant,
        },
        related: creditTransactionId ? { creditTransactionId } : undefined,
      });

      req.logger.info(`Admin ${req.user!.id} granted team subscription to organization ${targetOrganization.id}`, {
        seats,
        credits: creditsToAdd,
        durationMonths,
        userId,
      });
    });

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

    await notifyAfterCommit(req, () => Promise.all(promises));

    return {
      success: true,
      message: `Team subscription granted for ${durationMonths} month(s)`,
      organizationId: targetOrganization.id,
      subscriptionRecordId,
      seats,
      credits: seats * teamPlan.creditsPerSeat * durationMonths,
    };
  }

  throw new BadRequestError('Invalid subscription type');
}
