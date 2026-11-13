import { ApiKeyScope, assessmentSuggestionAcceptSchema } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, ConflictError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest, userAuditTarget } from '@bike4mind/server-utils/utils/adminAudit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi, requireAdminPermission } from '@server/middlewares/adminApi';
import { recordAiDecision, withAiSuggestionId } from '@server/admin/ai/audit';
import { userAssessmentSuggestion } from '@server/admin/ai/assessmentSuggestion';

const ONE_MINUTE_MS = 60_000;
const ACCEPT_RATE_LIMIT = 60;

/** Each queue keeps the permission its own page needs to act. */
const SURFACE_PERMISSION = {
  signupRiskReview: 'users:moderate',
  heldSignupGrant: 'credits:adjust',
} as const;

const SURFACE_LABEL = {
  signupRiskReview: 'signup risk review',
  heldSignupGrant: 'held signup grant',
} as const;

/**
 * Accepts an abuse assessment on a user queue (Risk review, Held signup grants). Accepting there means
 * leaving the account as it is, so this records the agreement and changes nothing on the account;
 * approving or releasing against the assessment goes through those queues' own audited endpoints.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: ['users:moderate', 'credits:adjust'] },
})
  .use(rateLimit({ limit: ACCEPT_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-ai-assessment-accept' }))
  .post(
    asyncHandler(async (req, res) => {
      const parsed = assessmentSuggestionAcceptSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a queue, a user id and an assessment id');
      const { surface, userId, assessmentId } = parsed.data;
      requireAdminPermission(req, SURFACE_PERMISSION[surface]);

      const suggestion = await userAssessmentSuggestion(surface, userId.toLowerCase(), assessmentId);
      // The strict audit entry rides in the same transaction, so an unrecorded accept rolls back.
      await withTransaction(async () => {
        const decided = await recordAiDecision(suggestion.id, 'accepted', {
          decidedBy: { userId: req.user.impersonatedBy ?? req.user.id, name: req.user.username || 'Admin' },
          overrideCostly: false,
        });
        if (!decided) throw new ConflictError('This suggestion was already reviewed');
        await recordAdminActionFromRequest(req, {
          action: 'security.ai_assessment.accepted',
          target: await userAuditTarget(userId),
          summary: `accepted the abuse assessment on a ${SURFACE_LABEL[surface]}`,
          details: withAiSuggestionId({ surface, assessmentId }, suggestion.id),
        });
      });
      res.status(200).json({ aiSuggestionId: suggestion.id });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
