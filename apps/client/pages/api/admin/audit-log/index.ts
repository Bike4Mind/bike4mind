import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope, encodeAuditCursor, type AuditLogPage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { ensurePlatformAdmin, parseAuditListQuery } from '@server/utils/adminAuditQuery';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensurePlatformAdmin(req.user);
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
