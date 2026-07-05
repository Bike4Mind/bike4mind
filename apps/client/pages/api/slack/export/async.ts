import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { slackDevWorkspaceRepository, slackExportJobRepository } from '@bike4mind/database';
import { sendToQueue } from '@server/utils/sqs';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

/**
 * Async Slack Channel Export API
 *
 * Queues a background job to export large Slack channels
 * Returns immediately with a job ID for status polling
 */

const ExportRequestSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  channelId: z.string().min(1, 'channelId is required'),
  dateRange: z
    .object({
      start: z.iso.datetime().optional(),
      end: z.iso.datetime().optional(),
    })
    .optional(),
  includeThreads: z.boolean().prefault(true),
  includeUserNames: z.boolean().prefault(true),
  format: z.enum(['json', 'csv', 'markdown']).prefault('json'),
});

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const handler = baseApi()
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);

    const userId = req.user?.id;
    if (!userId) {
      throw new ForbiddenError('User ID not found');
    }

    const result = ExportRequestSchema.safeParse(req.body);
    if (!result.success) {
      throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
    }

    const { workspaceId, channelId, dateRange, includeThreads, includeUserNames, format } = result.data;

    Logger.info('📦 [Slack Export] Starting async export', {
      workspaceId,
      channelId,
      format,
      includeThreads,
      includeUserNames,
      adminUserId: userId,
    });

    // Verify workspace exists and is active
    const workspace = await slackDevWorkspaceRepository.findByIdWithToken(workspaceId);
    if (!workspace || !workspace.isActive) {
      throw new BadRequestError('Workspace not found or inactive. Please check the workspace is still connected.');
    }

    if (!workspace.slackBotToken) {
      throw new BadRequestError(
        'Workspace authentication expired. Go to Admin → Slack Workspaces and reconnect your workspace.'
      );
    }

    // Check if user already has an active export
    const activeExport = await slackExportJobRepository.findActiveByUserId(userId);
    if (activeExport) {
      throw new BadRequestError(
        `You already have an export in progress (${activeExport.currentStep}). Please wait for it to complete or cancel it.`
      );
    }

    // Create the export job in database
    const job = await slackExportJobRepository.create({
      userId,
      workspaceId,
      channelId,
      format,
      includeThreads,
      includeUserNames,
      dateRange,
      status: 'pending',
      progress: 0,
      currentStep: 'Queued for processing...',
      totalMessages: 0,
      processedMessages: 0,
      threadsFetched: 0,
      threadRepliesFetched: 0,
      usersResolved: 0,
    });

    Logger.info('✅ [Slack Export] Job created', {
      jobId: job.id,
      workspaceId,
      channelId,
    });

    // Send message to SQS queue
    try {
      const queueUrl = getSourceQueueUrl('slackExportQueue');
      const messageId = await sendToQueue(queueUrl, {
        jobId: job.id,
        userId,
        workspaceId,
        channelId,
        format,
        includeThreads,
        includeUserNames,
        dateRange,
      });

      Logger.info('✅ [Slack Export] Message sent to queue', {
        jobId: job.id,
        messageId,
        queueUrl,
      });
    } catch (error: any) {
      // Mark job as failed if we can't queue it
      await slackExportJobRepository.markFailed(job.id, {
        message: `Failed to queue export job: ${error.message}`,
        stack: error.stack,
      });

      Logger.error('❌ [Slack Export] Failed to queue job', {
        jobId: job.id,
        error: error.message,
      });

      throw new BadRequestError('Failed to start export. Please try again.');
    }

    return res.json({
      success: true,
      jobId: job.id,
      status: 'pending',
      message: 'Export job queued successfully. Poll the status endpoint to track progress.',
    });
  })
  .get(async (req, res) => {
    // GET handler to list recent exports for the current user
    ensureAdmin(req.user?.isAdmin);

    const userId = req.user?.id;
    if (!userId) {
      throw new ForbiddenError('User ID not found');
    }

    const jobs = await slackExportJobRepository.findAllByUserId(userId, 10);

    return res.json({
      success: true,
      jobs: jobs.map(job => ({
        id: job.id,
        channelId: job.channelId,
        channelName: job.channelName,
        format: job.format,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        processedMessages: job.processedMessages,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        downloadUrl: job.status === 'completed' ? job.downloadUrl : undefined,
        downloadExpiresAt: job.downloadExpiresAt,
        errorMessage: job.errorMessage,
      })),
    });
  });

export default handler;
