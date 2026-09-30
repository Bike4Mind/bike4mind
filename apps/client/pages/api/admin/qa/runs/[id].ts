import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin, NotFoundError } from '@server/utils/errors';
import { getQaRunDetail } from '@server/qa/reads';
import { qaMediaStorage } from '@server/qa/storage';
import { signQaReportToken } from '@server/qa/reportToken';

const OBJECT_ID = /^[a-f0-9]{24}$/;

/** GET /api/admin/qa/runs/<id>. Failed tests with signed media URLs and the report link. */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (!OBJECT_ID.test(id)) throw new NotFoundError('Run not found');
  const detail = await getQaRunDetail(id, { storage: qaMediaStorage(), signReportToken: signQaReportToken });
  if (!detail) throw new NotFoundError('Run not found');
  return res.json(detail);
});

export default handler;
