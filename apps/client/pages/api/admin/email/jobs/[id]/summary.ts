import { canAccessAdmin } from '@bike4mind/common';
import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * GET /api/admin/email/jobs/:id/summary
 *
 * Get aggregated summary statistics for a job's send attempts.
 * Uses MongoDB aggregation for efficiency with large datasets.
 */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!canAccessAdmin(req.user)) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const { id } = req.query as { id: string };

  const job = await emailJobRepository.findById(id);
  if (!job) {
    throw new NotFoundError('Job not found');
  }

  // Get aggregated summary from send attempts
  const summary = await emailSendAttemptRepository.getJobSummary(id);

  return res.json({
    ...summary,
    // Include job-level metrics for reference
    jobMetrics: {
      recipientCount: job.recipientCount,
      overallStatus: job.overallStatus,
      lastSentAt: job.lastSentAt,
      lastSentBy: job.lastSentBy,
      openedCount: job.openedCount,
      clickedCount: job.clickedCount,
    },
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
