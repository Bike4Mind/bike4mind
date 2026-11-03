import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { reconcileOrgSeatsFromSubscription } from '@server/services/organizationService';
import { Resource } from 'sst';

interface RequestQuery {
  id: string;
}

/**
 * Admin remediation: re-sync an org's `seats` to its active subscription's
 * billed quantity. Unlike PATCH .../seats (which refuses Stripe-billed orgs
 * because a push to Stripe there would desync billing), this only PULLS from
 * the already-billed quantity, so it is safe to run on Stripe-billed orgs and
 * is the intended fix for orgs left with stale seats by the initial-purchase
 * webhook bug.
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const result = await reconcileOrgSeatsFromSubscription(id);
    if (!result) {
      throw new BadRequestError('Organization has no active Stripe subscription to reconcile seats from');
    }

    // Only audit + notify on an actual change so a no-op reconcile does not emit a
    // misleading audit entry or a spurious client invalidation.
    if (result.before !== result.after) {
      await recordAdminActionFromRequest(req, {
        action: 'org.seats.changed',
        target: { kind: 'organization', id: result.organization.id, displayName: result.organization.name },
        summary: `reconciled seats from ${result.before} to ${result.after}`,
        reason,
        changes: [{ field: 'seats', before: result.before, after: result.after }],
        details: { reconciledFrom: 'subscription', ownerId: result.organization.userId },
      });

      await sendToClient(result.organization.userId, Resource.websocket.managementEndpoint, {
        action: 'invalidate_query',
        queryKey: ['organizations'],
      });
    }

    return res.status(200).json({
      organizationId: result.organization.id,
      before: result.before,
      after: result.after,
    });
  })
);

export default handler;
