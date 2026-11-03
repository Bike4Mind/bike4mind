import { ApiKeyScope } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { encodeAuditCursor, parseCursorPageQuery } from '@server/utils/adminAuditQuery';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The admin audit entries about one subscription. Matches on both the Stripe-style `subscriptionId` and the
 * Mongo `_id`, because org revoke records the latter.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, { id: string; limit?: string; cursor?: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
    const { limit, cursor } = parseCursorPageQuery({ limit: req.query.limit, cursor: req.query.cursor });

    const { id } = req.query;
    const subscription = OBJECT_ID_PATTERN.test(id) ? await subscriptionRepository.findById(id) : null;
    if (!subscription) throw new NotFoundError('Subscription not found');

    const owner = {
      kind: subscription.ownerType === 'User' ? ('user' as const) : ('organization' as const),
      id: subscription.ownerId,
    };
    const page = await adminAuditLogRepository.listForSubscription(
      { owner, subscriptionIds: subscription.subscriptionId ? [subscription.subscriptionId, id] : [id] },
      { limit, cursor }
    );
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json({
      entries: page.entries,
      nextCursor: page.nextCursor ? encodeAuditCursor(page.nextCursor) : null,
    });
  })
);

export default handler;
