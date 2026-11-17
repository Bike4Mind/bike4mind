import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { imageModerationIncidentRepository } from '@bike4mind/database';
import { getReviewerListStatus } from '@bike4mind/server-utils/moderation/imageModerationIncidents';
import { adminApi } from '@server/middlewares/adminApi';

/**
 * Counts for the moderation review page: incidents waiting (and how many of them are escalated or
 * stuck mid-report), how closed ones ended, the oldest wait, and whether each reviewer list has a
 * usable address. Counts and booleans only; the queue route lists the incidents themselves.
 */
const handler = adminApi({
  // A new route outside /api/v1 takes signed-in sessions only (scripts/check-contract-gate.sh).
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
}).get(async (_req, res) => {
  const [summary, reviewerLists] = await Promise.all([
    imageModerationIncidentRepository.summarize(),
    getReviewerListStatus(),
  ]);
  return res.status(200).json({
    needsReview: summary.needsReview,
    escalated: summary.escalated,
    stuck: summary.stuck,
    closed: {
      noAction: summary.closed.noAction,
      falsePositive: summary.closed.falsePositive,
      reported: summary.closed.reported,
    },
    oldestPendingCreatedAt: summary.oldestPendingCreatedAt,
    reviewersConfigured: reviewerLists.reviewersConfigured,
    escalationReviewersConfigured: reviewerLists.escalationReviewersConfigured,
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
