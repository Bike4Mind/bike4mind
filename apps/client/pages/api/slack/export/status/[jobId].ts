import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError, NotFoundError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { slackExportJobRepository } from '@bike4mind/database';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Slack Export Status API
 *
 * GET /api/slack/export/status/[jobId] - Get export job status
 * DELETE /api/slack/export/status/[jobId] - Cancel export job
 */

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

/**
 * Generate a new presigned URL for downloading the export
 */
async function refreshDownloadUrl(s3Bucket: string, s3Key: string): Promise<{ url: string; expiresAt: Date }> {
  const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

  const command = new GetObjectCommand({
    Bucket: s3Bucket,
    Key: s3Key,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: PRESIGNED_URL_EXPIRY });
  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY * 1000);

  return { url, expiresAt };
}

const handler = baseApi()
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const userId = req.user?.id;
    if (!userId) {
      throw new ForbiddenError('User ID not found');
    }

    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('Job ID is required');
    }

    const job = await slackExportJobRepository.findByIdAndUserId(jobId, userId);
    if (!job) {
      throw new NotFoundError('Export job not found');
    }

    // If job is completed and download URL is expired, refresh it
    let downloadUrl = job.downloadUrl;
    let downloadExpiresAt = job.downloadExpiresAt;

    if (job.status === 'completed' && job.s3Bucket && job.s3Key) {
      const now = new Date();
      const isExpired = !job.downloadExpiresAt || new Date(job.downloadExpiresAt) < now;

      if (isExpired) {
        Logger.info('🔄 [Slack Export] Refreshing expired download URL', { jobId });

        const refreshed = await refreshDownloadUrl(job.s3Bucket, job.s3Key);
        downloadUrl = refreshed.url;
        downloadExpiresAt = refreshed.expiresAt;

        // Update the database with new URL
        await slackExportJobRepository.updateDownloadUrl(jobId, refreshed.url, refreshed.expiresAt);
      }
    }

    return res.json({
      success: true,
      job: {
        id: job.id,
        channelId: job.channelId,
        channelName: job.channelName,
        format: job.format,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        // Statistics
        totalMessages: job.totalMessages,
        processedMessages: job.processedMessages,
        threadsFetched: job.threadsFetched,
        threadRepliesFetched: job.threadRepliesFetched,
        usersResolved: job.usersResolved,
        // Timing
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        // Download info (only for completed jobs)
        downloadUrl: job.status === 'completed' ? downloadUrl : undefined,
        downloadExpiresAt: job.status === 'completed' ? downloadExpiresAt : undefined,
        fileSize: job.fileSize,
        // Error info (only for failed jobs)
        errorMessage: job.status === 'failed' ? job.errorMessage : undefined,
      },
    });
  })
  .delete(async (req, res) => {
    // Cancel an export job
    ensureAdmin(req.user?.isAdmin);

    const userId = req.user?.id;
    if (!userId) {
      throw new ForbiddenError('User ID not found');
    }

    const { jobId } = req.query;
    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('Job ID is required');
    }

    const cancelled = await slackExportJobRepository.cancel(jobId, userId);

    if (!cancelled) {
      // Job might not exist or might already be completed/failed/cancelled
      const job = await slackExportJobRepository.findByIdAndUserId(jobId, userId);
      if (!job) {
        throw new NotFoundError('Export job not found');
      }

      if (job.status === 'completed') {
        throw new BadRequestError('Cannot cancel a completed export');
      }
      if (job.status === 'failed') {
        throw new BadRequestError('Cannot cancel a failed export');
      }
      if (job.status === 'cancelled') {
        throw new BadRequestError('Export is already cancelled');
      }

      throw new BadRequestError('Failed to cancel export');
    }

    Logger.info('✅ [Slack Export] Job cancelled', { jobId, userId });

    return res.json({
      success: true,
      message: 'Export cancelled successfully',
    });
  });

export default handler;
