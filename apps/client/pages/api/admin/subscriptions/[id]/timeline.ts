import { z } from 'zod';
import {
  ApiKeyScope,
  SUBSCRIPTION_TIMELINE_KINDS,
  SubscriptionTimelineKindSchema,
  type SubscriptionTimelinePage,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { decodeAuditCursor, encodeAuditCursor } from '@server/utils/adminAuditQuery';
import { listSubscriptionTimeline } from '@server/utils/subscriptionTimeline';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const TIMELINE_DEFAULT_LIMIT = 100;
const TIMELINE_MAX_LIMIT = 500;

const TimelineQuerySchema = z.object({
  id: z.string(),
  kind: SubscriptionTimelineKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_LIMIT).default(TIMELINE_DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

/** One subscription's merged feed: Stripe billing events, admin actions and plan credit moves, newest first. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler<{}, unknown, unknown, Record<string, unknown>>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const parsed = TimelineQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid query parameters');
    const { id, kind, limit, cursor: rawCursor } = parsed.data;
    const cursor = rawCursor === undefined ? undefined : decodeAuditCursor(rawCursor);
    if (cursor === null) throw new BadRequestError('Invalid cursor');

    const subscription = OBJECT_ID_PATTERN.test(id) ? await subscriptionRepository.findById(id) : null;
    if (!subscription) throw new NotFoundError('Subscription not found');

    const { items, nextCursor } = await listSubscriptionTimeline(
      {
        id,
        stripeSubscriptionId: subscription.subscriptionId ?? null,
        owner: {
          kind: subscription.ownerType === 'User' ? 'user' : 'organization',
          id: subscription.ownerId,
        },
      },
      { kinds: kind ? [kind] : SUBSCRIPTION_TIMELINE_KINDS, limit, cursor }
    );
    const page: SubscriptionTimelinePage = {
      items,
      nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null,
    };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(page);
  })
);

export default handler;
