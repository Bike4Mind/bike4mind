import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { resolveSubscriptionSource, setSeats } from '@server/services/organizationService';
import { subscriptionRepository } from '@server/models/Subscription';
import { ORGANIZATION_SUBSCRIPTION_MAX_SEATS } from '@client/lib/subscriptions/constants';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { z } from 'zod';
import { Resource } from 'sst';

const SeatsSchema = z.object({
  seats: z.number().int().min(1).max(ORGANIZATION_SUBSCRIPTION_MAX_SEATS),
});

interface RequestQuery {
  id: string;
}

const handler = baseApi().patch(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { seats } = SeatsSchema.parse(req.body);

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

    await logAuditEvent(
      {
        userId: organization.userId,
        action: AdminOrgAuditEvents.ORG_SEATS_CHANGED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        metadata: {
          organizationId: organization.id,
          seats: organization.seats,
        },
      },
      req.logger
    );

    await sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });

    return res.status(200).json({ organizationId: organization.id, seats: organization.seats });
  })
);

export default handler;
