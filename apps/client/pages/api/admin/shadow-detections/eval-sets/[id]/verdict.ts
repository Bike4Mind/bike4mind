import { ApiKeyScope } from '@bike4mind/common';
import { abuseEvalSetRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { evalSetExampleVerdictRequestSchema, evalSetIdQuerySchema } from '@client/app/utils/verdictEvalSets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { respond } from '@server/utils/respond';
import { z } from 'zod';

const ONE_MINUTE_MS = 60_000;
export const EVAL_SET_VERDICT_RATE_LIMIT = 60;
export const EVAL_SET_STALE_MESSAGE = 'This example was labelled by someone else. Review it again.';
export const EVAL_SET_VERDICT_LIMIT_MESSAGE = 'This example already has the maximum number of verdicts.';

const recordedSchema = z.object({ ok: z.literal(true) });

/**
 * POST one verdict on one example. It names the revision it was decided against; a stale one, or one
 * past the per-example verdict cap, gets a 409. Verdicts append to the set's example only: the
 * account itself is never touched.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(rateLimit({ limit: EVAL_SET_VERDICT_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-eval-set-verdict' }))
  .post(
    asyncHandler(async (req, res) => {
      const parsed = evalSetExampleVerdictRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        const reasonIssue = parsed.error.issues.find(issue => issue.path[0] === 'reason');
        throw new BadRequestError(
          reasonIssue?.message ?? 'Expected an account id, its revision, a verdict and a reason'
        );
      }
      const { id: setId } = evalSetIdQuerySchema.parse(req.query);
      const { userId, verdict, expectedRevision, reason } = parsed.data;

      const result = await abuseEvalSetRepository.addExampleVerdict({
        setId,
        userId,
        expectedRevision,
        verdict,
        reason,
        reviewerId: req.user.id,
      });
      if (result === 'not_found') throw new NotFoundError('Evaluation set or example not found');
      if (result === 'conflict') throw new ConflictError(EVAL_SET_STALE_MESSAGE);
      if (result === 'limit_reached') throw new ConflictError(EVAL_SET_VERDICT_LIMIT_MESSAGE);

      // The verdict has committed: a failed audit write must not turn it into a 500 that a retry meets as a 409.
      try {
        await recordAdminActionFromRequest(req, {
          action: 'abuse.eval_set.verdict_recorded',
          target: { kind: 'system', id: setId, displayName: `Evaluation set ${setId}` },
          summary: `labelled an evaluation example as ${verdict}`,
          reason,
          details: { evalSetId: setId, userId, verdict },
        });
      } catch (error) {
        req.logger.error('Audit entry failed for an evaluation example verdict', error);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, recordedSchema, { ok: true });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
