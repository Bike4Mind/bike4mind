import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { verdictEvalQuerySchema, verdictEvalReportSchema } from '@client/app/utils/verdictEval';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { buildVerdictEvalReport } from '@server/security/verdictEval/loadVerdictEval';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
// Each call reads up to a window of detections and classifies the signup cohort.
export const VERDICT_EVAL_RATE_LIMIT = 10;

/**
 * GET /api/admin/shadow-detections/verdict-eval?days=7|30|90: how the AI assessments, the
 * auto-containment decisions and the signup chart's verdict agree with admin labels. Read-only; see
 * server/security/verdictEval.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: VERDICT_EVAL_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-verdict-eval' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = verdictEvalQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('days must be 7, 30 or 90');
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, verdictEvalReportSchema, await buildVerdictEvalReport(parsed.data.days));
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
