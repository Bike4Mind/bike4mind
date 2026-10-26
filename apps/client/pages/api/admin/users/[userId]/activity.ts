import { canAccessAdmin } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, type UserActivityPage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { encodeAuditCursor, parseUserActivityQuery } from '@server/utils/adminAuditQuery';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { hasAdminHistory, listUserActivity } from '@server/utils/userActivity';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Per-user Activity: one direction of the admin audit trail, optionally merged with the user's security events. */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));

  const { userId, ...query } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');
  const { direction, includeSecurity, limit, cursor } = parseUserActivityQuery(query);

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  const subject = {
    id: user.id,
    name: user.name || user.email || user.id,
    email: user.email ?? undefined,
    isAdmin: user.isAdmin,
  };

  const [{ entries, nextCursor }, actorViewAvailable] = await Promise.all([
    listUserActivity(subject, { direction, includeSecurity, limit, cursor }),
    hasAdminHistory(subject),
  ]);
  const page: UserActivityPage = {
    entries,
    nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null,
    actorViewAvailable,
  };

  Logger.info('[Admin] Queried user activity', { direction, includeSecurity, count: entries.length });
  return res.json(page);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
