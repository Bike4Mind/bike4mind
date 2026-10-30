import { ApiKeyScope } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { getActivitySummary } from '@server/admin/getActivitySummary';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 30, windowMs: 60 * 1000, bucket: 'admin-activity-summary' }))
  .get(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');
    return res.json(await getActivitySummary());
  });

export default handler;
