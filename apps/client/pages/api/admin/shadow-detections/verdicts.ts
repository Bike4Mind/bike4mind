import {
  ApiKeyScope,
  shadowDetectionBulkVerdictRequestSchema,
  shadowDetectionBulkVerdictResponseSchema,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const SHADOW_DETECTION_BULK_VERDICT_RATE_LIMIT = 30;

/**
 * Grades several shadow detections with one verdict and reason: a multi-row selection, or one account's
 * detections at once. Each record is graded as POST ./verdict would grade it, against its own revision;
 * records that moved come back as conflicts and are left alone, so a partial result is a 200. Each
 * graded record gets its own audit entry. Never acts on the accounts.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: SHADOW_DETECTION_BULK_VERDICT_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-shadow-detection-verdicts',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = shadowDetectionBulkVerdictRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected detection ids with their revisions and a verdict');
      const reason = parseAdminActionReason(parsed.data.reason);
      const { items, verdict } = parsed.data;

      const result = await shadowDetectionRepository.addVerdicts({ items, verdict, reason, reviewerId: req.user.id });

      // The verdicts have committed: a failed audit write is logged, never turned into a 500.
      for (const item of result.updated) {
        try {
          await recordAdminActionFromRequest(req, {
            action: 'security.detection.reviewed',
            target: { kind: 'system', id: item.id, displayName: `Shadow detection ${item.id}` },
            summary: `graded a ${item.detector} detection as ${verdict} (bulk, ${items.length} selected)`,
            reason,
            details: auditDetails(item),
          });
        } catch (error) {
          req.logger.error(`Audit entry failed for shadow detection verdict ${item.id}`, error);
        }
      }
      respond(res, shadowDetectionBulkVerdictResponseSchema, result);
    })
  );

const auditDetails = (item: ShadowDetectionItem) => ({
  detectionId: item.id,
  detector: item.detector,
  policyVersion: item.policyVersion,
  wouldAction: item.wouldAction,
  verdict: item.verdict,
  userIds: item.userIds,
});

export const config = { api: { externalResolver: true } };
export default handler;
