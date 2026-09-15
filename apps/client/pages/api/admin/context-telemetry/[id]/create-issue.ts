import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, BadRequestError } from '@server/utils/errors';
import { TELEMETRY_SAFE_PROJECTION } from '@server/utils/telemetryProjection';
import { type ContextTelemetry } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createTelemetryIssue } from '@server/utils/telemetryIssueCreator';

const paramsSchema = z.object({
  id: z.string().min(1),
});

const bodySchema = z.object({
  repository: z.string().min(1).describe('GitHub repository in owner/repo format'),
  additionalContext: z
    .string()
    .max(5000, 'Additional context must be 5000 characters or less')
    .optional()
    .describe('Additional context to include in the issue'),
});

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const logger = new Logger({
      metadata: {
        service: 'ContextTelemetryCreateIssue',
        adminUser: req.user.email ?? req.user.id,
      },
    });
    const { id } = paramsSchema.parse(req.query);
    const { repository, additionalContext } = bodySchema.parse(req.body);

    const quest = await Quest.findById(id).select(TELEMETRY_SAFE_PROJECTION).lean();

    if (!quest) {
      throw new NotFoundError(`Telemetry entry not found: ${id}`);
    }

    if (!quest.promptMeta?.contextTelemetry) {
      throw new NotFoundError(`No telemetry data for quest: ${id}`);
    }

    const telemetry = quest.promptMeta.contextTelemetry as ContextTelemetry;

    logger.info('Admin creating telemetry issue', {
      questId: id,
      repository,
      adminUser: req.user.email ?? req.user.id,
    });

    const result = await createTelemetryIssue({
      telemetry,
      repository,
      additionalContext,
      sourcePrefix: 'manual',
      llmTimeoutMs: 60000,
      questId: id,
      logger,
    });

    switch (result.status) {
      case 'created':
        res.json({
          success: true,
          issue: {
            number: result.issue.number,
            url: result.issue.html_url,
            title: result.issue.title,
            state: result.issue.state,
            labels: result.issue.labels,
          },
          telemetryId: id,
          hasAIAnalysis: result.hasAnalysis,
        });
        break;

      case 'duplicate':
        res.status(409).json({
          success: false,
          error: 'duplicate',
          message: `A telemetry issue already exists for this anomaly: #${result.existingIssue.number}`,
          existingIssue: {
            number: result.existingIssue.number,
            url: result.existingIssue.html_url,
          },
        });
        break;

      case 'error':
        switch (result.code) {
          case 'NO_GITHUB_CONNECTION':
            throw new BadRequestError(result.message);
          case 'INVALID_REPO_FORMAT':
            throw new BadRequestError(result.message);
          case 'REPO_NOT_ALLOWED':
            throw new ForbiddenError(result.message);
          case 'GITHUB_API_ERROR':
            throw new BadRequestError(result.message);
        }
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
