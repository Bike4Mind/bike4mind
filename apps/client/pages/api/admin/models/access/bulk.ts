import { BadRequestError, ModelAccessBulkRequestSchema } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import {
  applyModelAccessBulk,
  assertFullAdmin,
  dryRunModelAccessBulk,
  undoModelAccessBatch,
} from '@server/modelAccess/modelAccess';

const handler = adminApi({
  adminPermissions: { POST: 'settings:manage' },
  auth: 'jwtOnly',
}).post(async (req, res) => {
  assertFullAdmin(req.user);
  const body = parseOrBadRequest(ModelAccessBulkRequestSchema, req.body);
  if ('undoToken' in body) return res.json(await undoModelAccessBatch(req, body));
  const { selection, change, reason, dryRunToken, confirmAdminOnly } = body;
  if (!dryRunToken) return res.json(await dryRunModelAccessBulk(req.user.id, selection, change));
  if (!reason) throw new BadRequestError('A reason is required');
  return res.json(await applyModelAccessBulk(req, { selection, change, reason, dryRunToken, confirmAdminOnly }));
});

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '2mb' } } };
export default handler;
