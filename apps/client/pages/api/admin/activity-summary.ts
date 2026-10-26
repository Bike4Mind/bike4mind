import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { adminApi } from '@server/middlewares/adminApi';
import { getActivitySummary } from '@server/admin/getActivitySummary';

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'admin-activity-summary' }))
  .get(async (req, res) => {
    if (!canAccessAdmin(req.user)) throw new ForbiddenError('Admin access required');
    return res.json(await getActivitySummary());
  });

export default handler;
