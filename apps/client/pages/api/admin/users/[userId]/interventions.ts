import { ApiKeyScope, interventionHoldListSchema, interventionReleaseResponseSchema } from '@bike4mind/common';
import { autoContainmentDecisionRepository, userRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { readSignupGrantAdminAction } from '@server/credits/signupGrantAdminAction';
import { releaseInterventionDecision } from '@server/security/interventionRelease';
import { respond } from '@server/utils/respond';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * Graduated automated holds on one account (apps/workers/src/security/autoContainment). GET lists
 * them; POST { decisionId, reason } releases that decision's hold on this account only.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
})
  .use(csrfProtection())
  .get(
    asyncHandler(async (req, res) => {
      const userId = (req.query as { userId?: unknown } | undefined)?.userId;
      if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');
      const user = await userRepository.findById(userId);
      if (!user) throw new NotFoundError('User not found');
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, interventionHoldListSchema, { data: user.interventionHolds ?? [] });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const decisionId = (req.body as { decisionId?: unknown } | undefined)?.decisionId;
      if (typeof decisionId !== 'string' || !OBJECT_ID_PATTERN.test(decisionId)) {
        throw new BadRequestError('Expected a decision id');
      }
      const { userId, reason, target } = await readSignupGrantAdminAction(
        req,
        'user.intervention_hold.released',
        'release an automated hold on'
      );
      const decision = await autoContainmentDecisionRepository.findById(decisionId);
      if (!decision || !decision.userIds.includes(userId)) throw new NotFoundError('Hold not found');

      const userIds = await releaseInterventionDecision(decision, {
        userIds: [userId],
        by: req.user.id,
        reason,
        condition: 'admin_release',
        now: new Date(),
      });
      if (userIds.length > 0) {
        await recordAdminActionFromRequest(req, {
          action: 'user.intervention_hold.released',
          target,
          summary: `released an automated ${decision.tier} hold`,
          reason,
          details: { decisionId, detectionId: decision.detectionId, tier: decision.tier },
        });
      }
      respond(res, interventionReleaseResponseSchema, { released: [{ decisionId, userIds }] });
    })
  );

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
