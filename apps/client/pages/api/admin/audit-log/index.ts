import { canAccessAdmin } from '@bike4mind/common';
import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope, type AuditLogPage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { encodeAuditCursor, parseAuditListQuery } from '@server/utils/adminAuditQuery';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  ensureAdmin(canAccessAdmin(req.user));
  const { filters, limit, cursor } = parseAuditListQuery(req.query);

  const { entries, nextCursor } = await adminAuditLogRepository.list(filters, { limit, cursor });
  const page: AuditLogPage = { entries, nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null };

  Logger.info('[Admin] Queried admin audit log', { count: entries.length, hasMore: nextCursor !== null });
  return res.json(page);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
