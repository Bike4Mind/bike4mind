import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, MODERATION_PAGE_READ, type UserTimelinePage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { encodeAuditCursor, parseUserTimelineQuery } from '@server/utils/adminAuditQuery';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { listUserTimeline } from '@server/utils/userTimeline';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** The unified per-user timeline (spend, limits, security, money and admin rows), merged server-side; see userTimeline.ts. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
}).get(async (req, res) => {
  const { userId, ...query } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');
  const { types, range, limit, cursor, apiKeyId } = parseUserTimelineQuery(query);

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  const subject = {
    id: user.id,
    name: user.name || user.email || user.id,
    email: user.email ?? undefined,
    isAdmin: user.isAdmin,
    account: {
      createdAt: user.createdAt,
      currentCredits: user.currentCredits ?? 0,
      email: user.email ?? undefined,
      signupMeta: user.signupMeta,
      signupGrantHeldReason: user.signupGrantHeldReason,
    },
  };

  const { entries, nextCursor } = await listUserTimeline(subject, {
    types,
    range,
    limit,
    cursor,
    ...(apiKeyId ? { apiKeyId } : {}),
  });
  const page: UserTimelinePage = { entries, nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null };

  Logger.info('[Admin] Queried user timeline', { types, count: entries.length });
  return res.json(page);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
