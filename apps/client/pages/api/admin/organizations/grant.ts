import {
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { organizationService, creditService } from '@bike4mind/services';
import { CreditHolderType, dayjs } from '@bike4mind/common';
import {
  ORGANIZATION_SUBSCRIPTION_MAX_SEATS,
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
} from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { z } from 'zod';
import { Resource } from 'sst';
import { randomUUID } from 'crypto';

// Admin grants carry a `periodEndsAt` 12 months out for accounting / UI
// labelling. It is informational - there is NO cron that flips status to
// `canceled` when the date elapses. Revocation is an explicit admin action
// via /api/admin/organizations/:id/revoke. If automated expiry becomes a
// requirement, wire a sweeper in infra/cron.ts.
const GRANT_DURATION_MONTHS = 12;
// Sanity cap on initial credits - protects against admin typos (extra zero).
const MAX_INITIAL_CREDITS = 10_000_000;

const GrantOrgSchema = z.object({
  name: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  seats: z.number().int().min(1).max(ORGANIZATION_SUBSCRIPTION_MAX_SEATS),
  initialCredits: z.number().int().min(0).max(MAX_INITIAL_CREDITS),
  reason: z.string().min(1).max(500),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { name, ownerEmail, seats, initialCredits, reason } = GrantOrgSchema.parse(req.body);

    const owner = await userRepository.findByEmail(ownerEmail);
    if (!owner) {
      throw new NotFoundError(`No user with email ${ownerEmail}. Invite the user first, then grant the org.`);
    }

    const now = dayjs();
    const periodStartsAt = now.toDate();
    const periodEndsAt = now.add(GRANT_DURATION_MONTHS, 'months').toDate();

    // All writes inside a single transaction so a downstream failure (sub
    // create or credit grant) rolls back the org creation. Without this, a
    // transient DB hiccup could leave an orphaned organization with no
    // subscription record.
    //
    // (Double-click duplicate guard is handled by the UI mutation-pending
    // disabled state, not by a DB check - admins may legitimately want two
    // orgs with the same name across different owners.)
    const organization = await withTransaction(async () => {
      const org = await organizationService.create(
        owner,
        {
          name,
          seats,
          personal: false,
          stripeCustomerId: null,
        },
        {
          db: { organizations: organizationRepository },
        }
      );

      if (!org) {
        throw new BadRequestError('Failed to create organization');
      }

      await subscriptionRepository.create({
        ownerType: SubscriptionOwnerType.Organization,
        ownerId: org.id,
        // Sentinel id for admin grants - not a Stripe subscription, but the
        // unique index on subscriptionId is non-sparse (DocumentDB constraint),
        // so every row needs a real value. The `admin_grant_` prefix is the
        // discriminator separate from Stripe's `sub_` ids.
        subscriptionId: `admin_grant_${randomUUID()}`,
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

      if (initialCredits > 0) {
        await creditService.addCredits(
          {
            ownerId: org.id,
            ownerType: CreditHolderType.Organization,
            credits: initialCredits,
            type: 'subscription',
            metadata: { source: SubscriptionSource.AdminGrant, reason },
          },
          {
            db: { creditTransactions: creditTransactionRepository },
            creditHolderMethods: organizationRepository,
          }
        );
      }

      return org;
    });

    if (!organization) {
      throw new BadRequestError('Failed to create organization');
    }

    await logAuditEvent(
      {
        userId: owner.id,
        action: AdminOrgAuditEvents.ORG_GRANTED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        reason,
        metadata: {
          organizationId: organization.id,
          organizationName: organization.name,
          seats,
          initialCredits,
        },
      },
      req.logger
    );

    await sendToClient(owner.id, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });

    return res.status(201).json({
      organizationId: organization.id,
      name: organization.name,
      seats,
      initialCredits,
      ownerId: owner.id,
    });
  })
);

export default handler;
