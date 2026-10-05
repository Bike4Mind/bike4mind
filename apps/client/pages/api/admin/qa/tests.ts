import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';
import { getQaTestHistory } from '@server/qa/reads';

/** GET /api/admin/qa/tests?testKey= . Query param, not a path segment: keys contain / > ? #. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const testKey = req.query.testKey;
  if (typeof testKey !== 'string' || testKey.length === 0 || testKey.length > 1000) {
    throw new BadRequestError('testKey is required');
  }
  const history = await getQaTestHistory(testKey);
  if (!history) throw new NotFoundError('Test not found');
  return res.json(history);
});

export default handler;
