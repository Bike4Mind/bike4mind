import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { sendToClient } from '@server/websocket/utils';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';
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
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query as RequestQuery;
    if (!id) throw new BadRequestError('Organization id required');

    const result = await reconcileOrgSeatsFromSubscription(id);
    if (!result) {
      throw new BadRequestError('Organization has no active subscription to reconcile seats from');
    }

    await logAuditEvent(
      {
        userId: result.organization.userId,
        action: AdminOrgAuditEvents.ORG_SEATS_CHANGED,
        adminUserId: req.user!.id,
        adminUsername: req.user!.username,
        metadata: {
          organizationId: result.organization.id,
          seats: result.after,
          previousSeats: result.before,
          reconciledFrom: 'subscription',
        },
      },
      req.logger
    );

    await sendToClient(result.organization.userId, Resource.websocket.managementEndpoint, {
      action: 'invalidate_query',
      queryKey: ['organizations'],
    });

    return res.status(200).json({
      organizationId: result.organization.id,
      before: result.before,
      after: result.after,
    });
  })
);

export default handler;
