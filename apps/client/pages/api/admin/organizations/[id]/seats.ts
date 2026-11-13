import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope, TEAM_PLAN_SEATS_HARD_LIMIT } from '@bike4mind/common';
import { assertDelegateCanCreditOrganization } from '@server/admin/creditGrants/delegateTargets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import {
  pickPrimarySubscription,
  resolveSubscriptionSource,
  setSeats,
} from '@bike4mind/server-utils/services/organizationService';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { z } from 'zod';
import { Resource } from 'sst';

const SeatsSchema = z.object({
  // setSeats enforces the configured teamPlanMaxSeats ceiling; this is only the absolute rail.
  seats: z.number().int().min(1).max(TEAM_PLAN_SEATS_HARD_LIMIT),
});

interface RequestQuery {
  id: string;
}

const handler = adminApi({ requiredScopes: [ApiKeyScope.ADMIN], adminPermissions: { PATCH: 'credits:adjust' } }).patch(
  asyncHandler(async (req, res) => {
    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { seats } = SeatsSchema.parse(req.body);
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const target = await organizationRepository.findById(id);
    if (!target) throw new NotFoundError('Organization not found');
    await assertDelegateCanCreditOrganization(req.user, target, 'change seats on');

    // Block admin seat changes on Stripe-billed orgs. The customer manages
    // their own seats via the Stripe billing portal (which is itself gated
    // against admin_grant orgs - see apps/client/pages/api/stripe/portal.ts).
    // Without this guard, an admin click would update DB seats only, while
    // Stripe keeps invoicing the old quantity - a silent billing/seat desync.
    // The UI ungates this menu item for admin_grant orgs only; this is the
    // defense-in-depth check.
    const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      id
    );
    if (activeSubs.some(s => resolveSubscriptionSource(s) === SubscriptionSource.Stripe && s.subscriptionId)) {
      throw new ForbiddenError(
        'Cannot adjust seats on a Stripe-billed organization from the admin panel. The customer manages seats through their billing portal.'
      );
    }

    const organization = await setSeats(id, seats, { type: 'admin', userId: req.user!.id });
    // The row setSeats resizes, so the subscription detail page's admin log picks this entry up.
    const subscriptionId = pickPrimarySubscription(activeSubs)?.subscriptionId ?? null;

    await recordAdminActionFromRequest(req, {
      action: 'org.seats.changed',
      target: { kind: 'organization', id: organization.id, displayName: organization.name },
      summary: `set seats to ${organization.seats}`,
      reason,
      details: { seats: organization.seats, ownerId: organization.userId, subscriptionId },
    });

    await sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });

    return res.status(200).json({ organizationId: organization.id, seats: organization.seats });
  })
);

export default handler;
