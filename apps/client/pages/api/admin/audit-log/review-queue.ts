import { adminAuditLogRepository } from '@bike4mind/database';
import { ApiKeyScope, type AuditReviewQueuePage } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { encodeAuditCursor, parseAuditReviewQueueQuery } from '@server/utils/adminAuditQuery';

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const { status, from, limit, cursor } = parseAuditReviewQueueQuery(req.query);
  // Under impersonation req.user is the impersonated account; the queue hides the real admin's own actions.
  const viewerUserId = (req.user as { impersonatedBy?: string }).impersonatedBy ?? req.user.id;

  const { entries, nextCursor, total } = await adminAuditLogRepository.listReviewQueue(
    { status, from, viewerUserId },
    { limit, cursor }
  );
  const page: AuditReviewQueuePage = { entries, nextCursor: nextCursor ? encodeAuditCursor(nextCursor) : null, total };

  Logger.info('[Admin] Queried audit review queue', { status, count: entries.length, total });
  return res.json(page);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
