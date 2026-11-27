import { ApiKeyScope } from '@bike4mind/common';
import { abuseEvalSetRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { evalSetCreateRequestSchema, evalSetListSchema } from '@client/app/utils/verdictEvalSets';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { drawEvalSet } from '@server/security/verdictEval/evalSets';
import { respond } from '@server/utils/respond';
import { z } from 'zod';

const ONE_MINUTE_MS = 60_000;
// Each draw reads a window of detections and samples up to EVAL_SET_SAMPLE_DRAW_LIMIT signups (evalSets.ts).
export const EVAL_SET_CREATE_RATE_LIMIT = 3;

const createdSchema = z.object({ id: z.string() });

/**
 * GET lists the stored evaluation sets (counts only); POST draws a new frozen set from the window.
 * Both only read accounts: the sole write is the new AbuseEvalSet record and its audit entry.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
})
  .get(
    asyncHandler(async (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, evalSetListSchema, { data: await abuseEvalSetRepository.list() });
    })
  )
  .post(
    rateLimit({ limit: EVAL_SET_CREATE_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-eval-set-create' }),
    asyncHandler(async (req, res) => {
      const parsed = evalSetCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          'Expected a name, a 7, 30 or 90 day window, a sample of 10-500, and a held-out share of 0.2-0.8'
        );
      }
      const id = await drawEvalSet(parsed.data, req.user.id);
      try {
        await recordAdminActionFromRequest(req, {
          action: 'abuse.eval_set.created',
          target: { kind: 'system', id, displayName: `Evaluation set ${parsed.data.name}` },
          summary: `drew an abuse evaluation set over ${parsed.data.days} days`,
          details: {
            evalSetId: id,
            days: parsed.data.days,
            unflaggedSample: parsed.data.unflaggedSample,
            heldOutShare: parsed.data.heldOutShare,
          },
        });
      } catch (error) {
        req.logger.error('Audit entry failed for abuse evaluation set creation', error);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, createdSchema, { id }, 201);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
