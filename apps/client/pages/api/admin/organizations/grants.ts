import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { SubscriptionOwnerType, SubscriptionSource } from '@client/lib/subscriptions/types';
import { Subscription } from '@server/models/Subscription';

/**
 * Returns the set of active admin-granted Subscriptions, scoped to Organizations.
 * Used by the admin UI to render a "Granted" badge on org rows.
 */
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    // Bound the result set. 500 admin-granted orgs is far past the design
    // intent; add pagination if that ever becomes a real number.
    const GRANTS_LIMIT = 500;
    const grants = await Subscription.find({
      ownerType: SubscriptionOwnerType.Organization,
      source: SubscriptionSource.AdminGrant,
      status: 'active',
    })
      .select({ ownerId: 1, grantedBy: 1, grantedReason: 1, quantity: 1, periodEndsAt: 1 })
      .limit(GRANTS_LIMIT)
      .lean({ virtuals: true });

    // Surface the truncation rather than silently dropping the 501st badge.
    const truncated = grants.length === GRANTS_LIMIT;
    if (truncated) {
      req.logger.warn(
        `admin/organizations/grants hit ${GRANTS_LIMIT}-row cap — UI may be missing "Granted" badges. Add pagination.`
      );
    }

    return res.status(200).json({ grants, truncated, limit: GRANTS_LIMIT });
  })
);

export default handler;
