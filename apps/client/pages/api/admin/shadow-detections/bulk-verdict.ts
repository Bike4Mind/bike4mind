import {
  ApiKeyScope,
  shadowDetectionBulkVerdictRequestSchema,
  shadowDetectionBulkVerdictResponseSchema,
  SHADOW_DETECTION_BULK_VERDICT_LIMIT,
} from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const SHADOW_DETECTION_BULK_VERDICT_RATE_LIMIT = 10;

/**
 * Grades many shadow detections with one verdict and reason (the selection or every row matching the
 * current filter on the Detections page). Each record is graded as POST ./verdict would grade it: its
 * own revision check, verdict-history entry and audit line. Records changed since they were selected
 * come back as conflicts, ungraded. Grading never acts on the accounts a detection names.
 */
// Same permission as a single verdict (./verdict.ts).
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: SHADOW_DETECTION_BULK_VERDICT_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-shadow-detection-bulk-verdict',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = shadowDetectionBulkVerdictRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError(
          `Expected 1 to ${SHADOW_DETECTION_BULK_VERDICT_LIMIT} distinct detections with their revisions, and a verdict`
        );
      }
      const reason = parseAdminActionReason(parsed.data.reason);
      const { items, verdict } = parsed.data;

      const result = await shadowDetectionRepository.addVerdicts({ items, verdict, reason, reviewerId: req.user.id });

      // Verdicts have committed: an audit failure is logged, never turned into a 500 the reviewer would
      // retry into conflicts against their own verdicts.
      for (const item of result.graded) {
        try {
          await recordAdminActionFromRequest(req, {
            action: 'security.detection.reviewed',
            target: { kind: 'system', id: item.id, displayName: `Shadow detection ${item.id}` },
            summary: `graded a ${item.detector} detection as ${verdict} in bulk`,
            reason,
            details: {
              detectionId: item.id,
              detector: item.detector,
              policyVersion: item.policyVersion,
              wouldAction: item.wouldAction,
              verdict: item.verdict,
              userIds: item.userIds,
              bulkSize: items.length,
            },
          });
        } catch (error) {
          req.logger.error(`Audit entry failed for shadow detection verdict ${item.id}`, error);
        }
      }
      respond(res, shadowDetectionBulkVerdictResponseSchema, result);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
