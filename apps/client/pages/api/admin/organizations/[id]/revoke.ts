import { organizationRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { SubscriptionOwnerType, SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import { subscriptionRepository } from '@server/models/Subscription';
import { resolveSubscriptionSource } from '@server/services/organizationService';
import { Resource } from 'sst';

interface RequestQuery {
  id: string;
}

// Revocation is the ONLY mechanism that ends an admin grant: there is no
// cron that auto-cancels expired grants based on `periodEndsAt`. Already-
// granted credits are intentionally NOT reclaimed here - the org keeps any
// balance it has spent or accrued. Both behaviours are deliberate.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

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

    // Cancel and audit commit together: a strict audit failure rolls the cancel back, so a retry can still succeed.
    await withTransaction(async () => {
      await subscriptionRepository.update({
        id: adminGrant.id,
        status: 'canceled',
        canceledAt: new Date(),
      });

      await recordAdminActionFromRequest(req, {
        action: 'org.revoked',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
        summary: 'revoked admin grant',
        reason,
        changes: [{ field: 'subscription.status', before: adminGrant.status, after: 'canceled' }],
        details: { subscriptionId: adminGrant.id, ownerId: organization.userId },
      });
    });

    await sendToClient(organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['subscriptions'],
    });

    return res.status(200).json({ organizationId: organization.id, status: 'canceled' });
  })
);

export default handler;
