import { ApiKeyScope } from '@bike4mind/common';
import { abuseEvalSetRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { evalSetDetailSchema, evalSetIdQuerySchema } from '@client/app/utils/verdictEvalSets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { toEvalSetDetail } from '@server/security/verdictEval/evalSetMath';
import { respond } from '@server/utils/respond';

/** GET one evaluation set: its examples with labels and the last two runs. Read-only. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
}).get(
  asyncHandler(async (req, res) => {
    const { id } = evalSetIdQuerySchema.parse(req.query);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new NotFoundError('Evaluation set not found');
    res.setHeader('Cache-Control', 'private, no-store');
    respond(res, evalSetDetailSchema, toEvalSetDetail(set));
  })
);

export const config = { api: { externalResolver: true } };
export default handler;
