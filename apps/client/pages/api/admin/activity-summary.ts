import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getActivitySummary } from '@server/admin/getActivitySummary';

const handler = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'admin-activity-summary' }))
  .get(async (req, res) => {
    return res.json(await getActivitySummary());
  });

export default handler;
