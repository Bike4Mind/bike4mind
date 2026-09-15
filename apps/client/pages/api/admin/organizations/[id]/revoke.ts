import { organizationRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { z } from 'zod';
import { Resource } from 'sst';

const RevokeSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

interface RequestQuery {
  id: string;
}

// Revocation is the ONLY mechanism that ends an admin grant: there is no
// cron that auto-cancels expired grants based on `periodEndsAt`. Already-
// granted credits are intentionally NOT reclaimed here - the org keeps any
// balance it has spent or accrued. Both behaviours are deliberate.
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const { reason } = RevokeSchema.parse(req.body);

    const organization = await organizationRepository.findById(id);
    if (!organization) throw new NotFoundError('Organization not found');

    const activeSubs = await subscriptionRepository.findActiveSubscriptionsByOwner(
      SubscriptionOwnerType.Organization,
      organization.id
    );
    const adminGrant = activeSubs.find(s => resolveSubscriptionSource(s) === SubscriptionSource.AdminGrant);
    if (!adminGrant) {
      throw new BadRequestError('No active admin grant to revoke');
    }

    await subscriptionRepository.update({
      id: adminGrant.id,
      status: 'canceled',
      canceledAt: new Date(),
    });

    await logAuditEvent(
      {
        userId: organization.userId,
        action: AdminOrgAuditEvents.ORG_REVOKED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        reason,
        metadata: {
          organizationId: organization.id,
          subscriptionId: adminGrant.id,
        },
      },
      req.logger
    );

    await sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['subscriptions'],
    });

    return res.status(200).json({ organizationId: organization.id, status: 'canceled' });
  })
);

export default handler;
