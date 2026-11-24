import { z } from 'zod';
import {
  ApiKeyScope,
  INTERVENTION_BULK_RELEASE_LIMIT,
  autoContainmentDecisionListSchema,
  interventionReleaseRequestSchema,
  interventionReleaseResponseSchema,
  type InterventionReleaseResponse,
} from '@bike4mind/common';
import { autoContainmentDecisionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { releaseInterventionDecision } from '@server/security/interventionRelease';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const INTERVENTION_DECISIONS_RATE_LIMIT = 30;

const listQuerySchema = z.object({ detectionId: z.string().regex(/^[a-f0-9]{24}$/) });

/**
 * Automated containment decisions. GET lists one detection's decisions; POST releases one applied
 * graduated decision ({ decisionId }) or, as a rollback, up to INTERVENTION_BULK_RELEASE_LIMIT
 * applied decisions of one tier ({ tier }). Release lifts only the holds those decisions applied.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read', POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: INTERVENTION_DECISIONS_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-intervention-decisions',
    })
  )
  .get(
    asyncHandler(async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Expected a detection id');
      const data = await autoContainmentDecisionRepository.listForDetection(parsed.data.detectionId);
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, autoContainmentDecisionListSchema, { data });
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = interventionReleaseRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a decision id or a tier, and a reason');
      const reason = parseAdminActionReason(parsed.data.reason);
      const now = new Date();

      const decisions =
        'decisionId' in parsed.data
          ? [await autoContainmentDecisionRepository.findById(parsed.data.decisionId)]
          : await autoContainmentDecisionRepository.listActiveByTier(parsed.data.tier, INTERVENTION_BULK_RELEASE_LIMIT);
      if ('decisionId' in parsed.data && (!decisions[0] || decisions[0].tier === 'contain')) {
        throw new NotFoundError('Decision not found');
      }

      const released: InterventionReleaseResponse['released'] = [];
      for (const decision of decisions) {
        if (!decision) continue;
        const skippedUserIds: string[] = [];
        const userIds = await releaseInterventionDecision(decision, {
          actor: req.user,
          onSkip: userId => skippedUserIds.push(userId),
          by: req.user.id,
          reason,
          condition: 'admin_release',
          now,
        });
        released.push({ decisionId: decision.id, userIds, skippedUserIds });
        for (const userId of userIds) {
          await recordAdminActionFromRequest(req, {
            action: 'user.intervention_hold.released',
            target: { kind: 'user', id: userId, displayName: userId },
            summary: `released an automated ${decision.tier} hold`,
            reason,
            details: { decisionId: decision.id, detectionId: decision.detectionId, tier: decision.tier },
          });
        }
      }
      respond(res, interventionReleaseResponseSchema, { released });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
