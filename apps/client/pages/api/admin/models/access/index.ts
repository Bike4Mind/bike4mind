import { ModelAccessPatchRequestSchema } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { assertFullAdmin, patchModelAccess } from '@server/modelAccess/modelAccess';
import { z } from 'zod';

// The id rides in the query: model ids contain `/`, `:` and spaces.
const QuerySchema = z.object({ id: z.string().trim().min(1).max(512) });

const handler = adminApi({
  adminPermissions: { PATCH: 'settings:manage' },
  auth: 'jwtOnly',
}).patch(async (req, res) => {
  assertFullAdmin(req.user);
  const { id } = parseOrBadRequest(QuerySchema, req.query);
  const body = parseOrBadRequest(ModelAccessPatchRequestSchema, req.body);
  return res.json(await patchModelAccess(req, id, body));
});

export const config = { api: { externalResolver: true } };
export default handler;
