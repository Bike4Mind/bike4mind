import { emailJobRepository, emailSendAttemptRepository } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * GET /api/admin/email/jobs/:id/summary
 *
 * Get aggregated summary statistics for a job's send attempts.
 * Uses MongoDB aggregation for efficiency with large datasets.
 */
const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
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
