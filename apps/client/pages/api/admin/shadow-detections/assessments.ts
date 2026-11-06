import {
  ApiKeyScope,
  abuseAssessmentListQuerySchema,
  abuseAssessmentListSchema,
  abuseAssessmentRunRequestSchema,
  abuseAssessmentRunResponseSchema,
} from '@bike4mind/common';
import { abuseAssessmentRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { assessShadowDetection } from '@server/security/abuseAssessment/abuseAssessment';
import { linkedAccountGroupEvidence } from '@server/security/abuseAssessment/linkedAccountEvidence';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const ABUSE_ASSESSMENTS_RATE_LIMIT = 60;

/**
 * Advisory model assessments of one shadow detection. GET lists them newest first; POST asks the
 * configured model now (subject to the operator's settings, budget and caps) and answers `skipped`
 * with a reason when it cannot. Assessments are evidence for the reviewer: they never act.
 */
// Asking spends platform budget on a judgment about an account, so it takes the moderation permission.
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
})
  .use(rateLimit({ limit: ABUSE_ASSESSMENTS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-abuse-assessments' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = abuseAssessmentListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Expected a detection id');
      const data = await abuseAssessmentRepository.listForDetection(parsed.data.detectionId);
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, abuseAssessmentListSchema, { data });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = abuseAssessmentRunRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a detection id');
      const outcome = await assessShadowDetection({
        detectionId: parsed.data.detectionId,
        trigger: 'admin',
        requestedBy: req.user.id,
        logger: req.logger,
        // Same evidence as the sweep, so both paths share one cached judgment per evidence.
        deps: { groupEvidence: linkedAccountGroupEvidence },
      });

      if (outcome.status === 'assessed' && !outcome.cached) {
        try {
          await recordAdminActionFromRequest(req, {
            action: 'security.detection.assessed',
            target: {
              kind: 'system',
              id: outcome.item.detectionId,
              displayName: `Shadow detection ${outcome.item.detectionId}`,
            },
            summary: `requested an advisory assessment (${outcome.item.result})`,
            details: {
              detectionId: outcome.item.detectionId,
              assessmentId: outcome.item.id,
              model: outcome.item.model,
              result: outcome.item.result,
              policyVersion: outcome.item.policyVersion,
            },
          });
        } catch (error) {
          req.logger.error(`Audit entry failed for abuse assessment ${outcome.item.id}`, error);
        }
      }
      respond(res, abuseAssessmentRunResponseSchema, outcome);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
