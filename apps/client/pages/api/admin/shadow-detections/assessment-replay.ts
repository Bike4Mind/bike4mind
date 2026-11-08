import {
  ApiKeyScope,
  abuseAssessmentReplayRequestSchema,
  abuseAssessmentReplayResponseSchema,
  SELF_ASSESSED_SHADOW_DETECTORS,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import {
  loadAbuseAssessmentSettings,
  replayAbuseAssessments,
  summarizeDetection,
} from '@server/security/abuseAssessment/abuseAssessment';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const ABUSE_ASSESSMENT_REPLAY_RATE_LIMIT = 5;
// Leaves room under the API timeout for the slowest call (10s text deadline) to finish.
const REPLAY_TIME_BUDGET_MS = 15_000;

/**
 * Replays candidate Decisions models over a fixed set of shadow detections and returns each model's
 * output per detection next to its human verdict, for offline comparison. Nothing is cached or
 * stored, and the platform budget and call cap still apply. A run that hits its time budget returns
 * the rows so far with reason `time_budget`; the caller reruns the rest.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'users:moderate' },
})
  .use(
    rateLimit({
      limit: ABUSE_ASSESSMENT_REPLAY_RATE_LIMIT,
      windowMs: ONE_MINUTE_MS,
      bucket: 'admin-abuse-assessment-replay',
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const parsed = abuseAssessmentReplayRequestSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError('Expected 1-50 detection ids and 1-3 decision models');
      const settings = await loadAbuseAssessmentSettings();
      if (!settings.enabled) {
        respond(res, abuseAssessmentReplayResponseSchema, {
          status: 'stopped',
          reason: 'disabled',
          rows: [],
          missing: [],
        });
        return;
      }
      const ids = [...new Set(parsed.data.detectionIds)];
      const found = await Promise.all(ids.map(id => shadowDetectionRepository.findById(id)));
      // A self-assessed detection carries its own verdict and summary shape, so it is not replayable.
      const replayable = (detection: ShadowDetectionItem | null): detection is ShadowDetectionItem =>
        detection !== null && !SELF_ASSESSED_SHADOW_DETECTORS.includes(detection.detector);
      const detections = found.filter(replayable);
      const missing = ids.filter((_, index) => !replayable(found[index]));

      const deadline = Date.now() + REPLAY_TIME_BUDGET_MS;
      const examples = [];
      for (const detection of detections) {
        examples.push({
          id: detection.id,
          label: detection.verdict,
          summary: await summarizeDetection(detection, req.logger),
        });
      }
      const result = await replayAbuseAssessments({
        examples,
        models: parsed.data.models,
        logger: req.logger,
        deadline,
        settings,
      });
      if (result.rows.length > 0) {
        try {
          await recordAdminActionFromRequest(req, {
            action: 'security.detection.replayed',
            target: { kind: 'system', id: 'abuse-assessment-replay', displayName: 'Abuse assessment replay' },
            summary: `replayed advisory assessments (${result.rows.length} rows)`,
            details: {
              detectionIds: detections.map(detection => detection.id),
              models: parsed.data.models,
              rows: result.rows.length,
            },
          });
        } catch (error) {
          req.logger.error('Audit entry failed for abuse assessment replay', error);
        }
      }
      respond(res, abuseAssessmentReplayResponseSchema, { ...result, missing });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
