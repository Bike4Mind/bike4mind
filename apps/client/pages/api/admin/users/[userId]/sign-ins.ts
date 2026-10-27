import { userRepository } from '@bike4mind/database';
import { ApiKeyScope, type UserSignInsPage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { encodeAuditCursor, parseCursorPageQuery } from '@server/utils/adminAuditQuery';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { listUserSignIns } from '@server/utils/userSignIns';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** A user's sign-in attempts from the auth audit, enriched with the matching client login record. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId, ...query } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');
  const { limit, cursor } = parseCursorPageQuery(query);

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const { entries, nextCursor } = await listUserSignIns(user.id, user.loginRecords ?? [], { limit, cursor });
  const page: UserSignInsPage = { entries, nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null };

  Logger.info('[Admin] Queried user sign-ins', { count: entries.length });
  return res.json(page);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
