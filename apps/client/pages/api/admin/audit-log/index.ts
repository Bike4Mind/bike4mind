import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope, type AuditLogPage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { encodeAuditCursor, parseAuditListQuery } from '@server/utils/adminAuditQuery';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
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
