import {
  creditLotRepository,
  creditTransactionRepository,
  organizationRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { organizationService, creditService } from '@bike4mind/services';
import { type AdminApproval, CreditHolderType, dayjs, TEAM_PLAN_SEATS_HARD_LIMIT } from '@bike4mind/common';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID } from '@bike4mind/server-utils/lib/subscriptions/constants';
import { getTeamPlanSettings } from '@bike4mind/server-utils/services/teamPlanSettings';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { priceAffectsEntitlements } from '@server/entitlements/paidStanding';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { z } from 'zod';
import { Resource } from 'sst';
import { randomUUID } from 'crypto';

import type { Request } from 'express';
import { approvalDetails } from './approval';

// Admin grants carry a `periodEndsAt` 12 months out for accounting / UI
// labelling. It is informational - there is NO cron that flips status to
// `canceled` when the date elapses. Revocation is an explicit admin action
// via /api/admin/organizations/:id/revoke. If automated expiry becomes a
// requirement, wire a sweeper in infra/cron.ts.
const GRANT_DURATION_MONTHS = 12;
// Sanity cap on initial credits - protects against admin typos (extra zero).
const MAX_INITIAL_CREDITS = 10_000_000;

export const GrantOrgSchema = z.object({
  name: z.string().min(1).max(120),
  ownerEmail: z.string().email(),
  // Absolute rail; the configured teamPlanMaxSeats ceiling is checked in the handler.
  seats: z.number().int().min(1).max(TEAM_PLAN_SEATS_HARD_LIMIT),
  initialCredits: z.number().int().min(0).max(MAX_INITIAL_CREDITS),
});

export const GrantOrgParamsSchema = GrantOrgSchema.extend({ reason: z.string() });
export type GrantOrgParams = z.infer<typeof GrantOrgParamsSchema>;

/** Seat ceiling and owner checks, run before a request is stored and again when it runs. */
export async function validateGrantOrg({ ownerEmail, seats }: Pick<GrantOrgParams, 'ownerEmail' | 'seats'>) {
  const { maxSeats } = await getTeamPlanSettings();
  if (seats > maxSeats) {
    throw new BadRequestError(`Seats cannot exceed ${maxSeats}`);
  }

  const owner = await userRepository.findByEmail(ownerEmail);
  if (!owner) {
    throw new NotFoundError(`No user with email ${ownerEmail}. Invite the user first, then grant the org.`);
  }
  return owner;
}

/** Creates the granted org as `req.user`; shared by the route and the approval executor. */
export async function grantOrg(req: Request, params: GrantOrgParams, approval?: AdminApproval) {
  const { name, seats, initialCredits, reason } = params;
  const owner = await validateGrantOrg(params);

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
        db: { organizations: organizationRepository, users: userRepository },
        logger: req.logger,
      }
    );

    if (!org) {
      throw new BadRequestError('Failed to create organization');
    }

    const subscriptionId = `admin_grant_${randomUUID()}`;
    await subscriptionRepository.create({
      ownerType: SubscriptionOwnerType.Organization,
      ownerId: org.id,
      // Sentinel id for admin grants - not a Stripe subscription, but the
      // unique index on subscriptionId is non-sparse (DocumentDB constraint),
      // so every row needs a real value. The `admin_grant_` prefix is the
      // discriminator separate from Stripe's `sub_` ids.
      subscriptionId,
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

    const ledger =
      initialCredits > 0
        ? await creditService.addCreditsWithLedgerRow(
            {
              ownerId: org.id,
              ownerType: CreditHolderType.Organization,
              credits: initialCredits,
              type: 'subscription',
              metadata: { source: SubscriptionSource.AdminGrant, reason },
            },
            {
              db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
              creditHolderMethods: organizationRepository,
              lotFundingSource: 'granted',
            }
          )
        : undefined;

    await recordAdminActionFromRequest(req, {
      action: 'org.credits.granted',
      target: { kind: 'organization', id: org.id, displayName: org.name },
      summary: `granted org with ${seats} seats and ${initialCredits} initial credits`,
      reason,
      details: {
        ...approvalDetails(approval),
        ownerId: owner.id,
        seats,
        initialCredits,
        credits: initialCredits,
        subscriptionId,
      },
      related: ledger?.creditTransactionId ? { creditTransactionId: ledger.creditTransactionId } : undefined,
    });

    return org;
  });

  if (!organization) {
    throw new BadRequestError('Failed to create organization');
  }

  await sendToClient(owner.id, Resource.websocket.managementEndpoint, {
    action: 'invalidate_query',
    queryKey: ['organizations'],
  });

  if (priceAffectsEntitlements(ORGANIZATION_SUBSCRIPTION_PRICE_ID)) {
    await sendToClient(owner.id, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['entitlements'],
    });
  }

  return {
    organizationId: organization.id,
    name: organization.name,
    seats,
    initialCredits,
    ownerId: owner.id,
  };
}
