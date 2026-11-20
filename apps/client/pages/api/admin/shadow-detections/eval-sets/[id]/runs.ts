import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import {
  evalSetIdQuerySchema,
  evalSetRunRequestSchema,
  evalSetRunResponseSchema,
} from '@client/app/utils/verdictEvalSets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { runEvalSet } from '@server/security/verdictEval/evalSets';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const EVAL_SET_RUN_RATE_LIMIT = 5;

/**
 * POST grades the set's held-out examples against the automated verdicts as they stand now, stores
 * the run on the set and returns it next to the previous one. Read-only on accounts.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(rateLimit({ limit: EVAL_SET_RUN_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-eval-set-run' }))
  .post(
    asyncHandler(async (req, res) => {
      const parsed = evalSetRunRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new BadRequestError('The note must be at most 500 characters');
      const { id: setId } = evalSetIdQuerySchema.parse(req.query);
      const result = await runEvalSet(setId, req.user.id, parsed.data.note ?? null);
      try {
        await recordAdminActionFromRequest(req, {
          action: 'abuse.eval_set.run',
          target: { kind: 'system', id: setId, displayName: `Evaluation set ${setId}` },
          summary: 'graded an abuse evaluation set',
          details: { evalSetId: setId, labelled: result.run.report.labelled },
        });
      } catch (error) {
        req.logger.error('Audit entry failed for an evaluation set run', error);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, evalSetRunResponseSchema, result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
