import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { getQaTestHistory } from '@server/qa/reads';

/** GET /api/admin/qa/tests?testKey= . Query param, not a path segment: keys contain / > ? #. */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  const testKey = req.query.testKey;
  if (typeof testKey !== 'string' || testKey.length === 0 || testKey.length > 1000) {
    throw new BadRequestError('testKey is required');
  }
  const history = await getQaTestHistory(testKey);
  if (!history) throw new NotFoundError('Test not found');
  return res.json(history);
});

export default handler;
