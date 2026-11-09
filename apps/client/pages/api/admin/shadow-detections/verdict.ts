import { z } from 'zod';
import {
  ApiKeyScope,
  shadowDetectionItemSchema,
  shadowDetectionVerdictRequestSchema,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const SHADOW_DETECTION_VERDICT_RATE_LIMIT = 60;

export const SHADOW_DETECTION_STALE_MESSAGE = 'This detection was graded by someone else. Review it again.';

const conflictSchema = z.object({ error: z.string(), item: shadowDetectionItemSchema });

const auditDetails = (item: ShadowDetectionItem) => ({
  detectionId: item.id,
  detector: item.detector,
  policyVersion: item.policyVersion,
  wouldAction: item.wouldAction,
  verdict: item.verdict,
  userIds: item.userIds,
});

/**
 * Grades one shadow detection. A verdict names the revision it was decided against; a stale one gets
 * a 409 with the current record so the reviewer can look again. Grading only appends to the
 * detection record: it never acts on the accounts it names.
 */
// Grading judges whether an account abused the service, so it takes the moderation permission.
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: SHADOW_DETECTION_VERDICT_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-shadow-detection-verdict',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = shadowDetectionVerdictRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected a detection id, its revision and a verdict');
      const reason = parseAdminActionReason(parsed.data.reason);
      const { id, expectedRevision, verdict } = parsed.data;

      const result = await shadowDetectionRepository.addVerdict({
        id,
        expectedRevision,
        verdict,
        reason,
        reviewerId: req.user.id,
      });
      if (result.status === 'not_found') throw new NotFoundError('Detection not found');
      if (result.status === 'conflict') {
        respond(res, conflictSchema, { error: SHADOW_DETECTION_STALE_MESSAGE, item: result.item }, 409);
        return;
      }

      // The verdict has already committed: a failed audit write must not turn it into a 500, which the
      // reviewer's retry would then meet as a 409 against their own verdict.
      try {
        await recordAdminActionFromRequest(req, {
          action: 'security.detection.reviewed',
          target: { kind: 'system', id: result.item.id, displayName: `Shadow detection ${result.item.id}` },
          summary: `graded a ${result.item.detector} detection as ${verdict}`,
          reason,
          details: auditDetails(result.item),
        });
      } catch (error) {
        req.logger.error(`Audit entry failed for shadow detection verdict ${result.item.id}`, error);
      }
      respond(res, shadowDetectionItemSchema, result.item);
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
