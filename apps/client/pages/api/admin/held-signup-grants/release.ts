import { z } from 'zod';
import { assertCanActOnAdminTarget, assessmentAiDecisionSchema } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  loadCreditGrantPolicy,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@bike4mind/server-utils/utils/adminAudit';
import { withAiSuggestionId } from '@server/admin/ai/audit';
import { recordUserAssessmentOverride, userAssessmentSuggestion } from '@server/admin/ai/assessmentSuggestion';
import { buildHeldGrantAdapters, heldGrantBatches } from '@bike4mind/server-utils/credits/heldSignupGrantAdapters';

const bodySchema = z.object({
  userIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/i))
    .min(1)
    .max(userService.MAX_BULK_RELEASE),
  dryRun: z.boolean().optional(),
  /** Validated by the shared admin reason rule; required on every release (not on a dry run). */
  reason: z.unknown().optional(),
  /** Releasing one account over its abuse assessment: recorded as an override of that suggestion. */
  aiDecision: assessmentAiDecisionSchema.optional(),
});

const auditDetails = (credits: number, batchId: string) => ({ credits, source: 'held_grant_release', batchId });

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'credits:adjust' } })
  .use(csrfProtection())
  .post(
    asyncHandler(async (req, res) => {
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success)
        throw new BadRequestError(`Expected 1 to ${userService.MAX_BULK_RELEASE} user ids in userIds`);
      const userIds = parsed.data.userIds.map(userId => userId.toLowerCase());
      // The whole request is refused, like the single-account credit route, rather than partly paid.
      for (const userId of userIds) {
        if (!isSelfOrImpersonator(req.user, userId)) continue;
        await denySelfAdminAction(req, {
          action: 'user.credits.denied',
          attempted: 'user.credits.adjusted',
          target: { kind: 'user', id: userId, displayName: userId },
        });
      }
      for (const account of await userRepository.findAdminTargetsByIds(userIds))
        assertCanActOnAdminTarget(req.user, account, 'release signup credits for');
      const { aiDecision } = parsed.data;
      if (aiDecision && userIds.length !== 1)
        throw new BadRequestError('An AI suggestion decision applies to releasing one account');
      if (parsed.data.dryRun) {
        const preview = await userService.previewSignupGrantAction(
          { action: 'release_held', userIds },
          { users: userRepository }
        );
        return res.status(200).json(preview);
      }
      const reason = parseAdminActionReason(parsed.data.reason);
      // Validated before paying: an assessment that does not name the account is a 400.
      const aiSuggestion = aiDecision
        ? await userAssessmentSuggestion('heldSignupGrant', userIds[0], aiDecision.assessmentId)
        : null;
      const result = await userService.bulkReleaseHeldGrants(
        { actorId: req.user.id, userIds },
        { ...buildHeldGrantAdapters(req.logger), batches: heldGrantBatches }
      );
      let policy: ReturnType<typeof loadCreditGrantPolicy> | undefined;
      for (const row of result.results) {
        if (row.outcome !== 'released' || row.credits <= 0) continue;
        try {
          await recordAdminActionFromRequest(
            req,
            {
              action: 'user.credits.adjusted',
              target: { kind: 'user', id: row.userId, displayName: row.userId },
              summary: 'released held signup grant',
              reason,
              details: aiSuggestion
                ? withAiSuggestionId(auditDetails(row.credits, result.batchId), aiSuggestion.id)
                : auditDetails(row.credits, result.batchId),
            },
            { creditGrantPolicy: () => (policy ??= loadCreditGrantPolicy()) }
          );
        } catch (error) {
          req.logger.error(`Audit entry failed for released held grant of user ${row.userId}`, error);
        }
      }
      const released = result.results.some(row => row.outcome === 'released');
      if (aiSuggestion && released) {
        // The payout already committed; a failed suggestion write is logged rather than failing it.
        try {
          const decided = await recordUserAssessmentOverride(aiSuggestion, {
            overrideAction: { action: 'release' },
            overrideReason: aiDecision?.overrideReason ?? reason,
            decidedBy: { userId: req.user.impersonatedBy ?? req.user.id, name: req.user.username || 'Admin' },
          });
          // Decided by a concurrent accept after the pre-check: the release stands but is not recorded as an override.
          if (!decided)
            req.logger.warn('AI suggestion already decided; release not recorded as an override', {
              suggestionId: aiSuggestion.id,
            });
        } catch (error) {
          req.logger.error('AI suggestion override failed for held grant release', {
            suggestionId: aiSuggestion.id,
            error,
          });
        }
      }
      res.status(200).json(result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
