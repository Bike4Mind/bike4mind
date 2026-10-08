import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { AdminSettings } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import type { WhatsNewHighlightsPayload } from '@server/whatsNew/whatsNewHighlights.types';
import { Logger } from '@bike4mind/observability';
import { loadHighlightsReleaseNotes, parseHighlightsEndDate } from '@server/whatsNew/releaseNoteHighlights';

// Rate limiting - 1 request per minute to prevent abuse
const GENERATE_RATE_LIMIT = 1;
const ONE_MINUTE_MS = 60 * 1000;

const SETTING_NAME = 'whatsNewHighlightsConfig';

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: GENERATE_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .post(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      // Get configuration
      const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
      const config = setting?.settingValue as
        | {
            enabled?: boolean;
            slackChannelId?: string;
            slackTeamId?: string;
          }
        | undefined;

      if (!config?.slackChannelId || !config?.slackTeamId) {
        return res.status(400).json({
          error: 'Slack channel not configured. Please configure the Slack channel first.',
        });
      }

      // Accept optional custom date range
      const {
        startDate: customStart,
        endDate: customEnd,
        dryRun,
      } = req.body as {
        startDate?: string;
        endDate?: string;
        dryRun?: boolean;
      };

      let startDate: Date;
      let endDate: Date;

      if (customStart && customEnd) {
        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(customStart) || !dateRegex.test(customEnd)) {
          return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format' });
        }

        startDate = new Date(customStart + 'T00:00:00Z');
        endDate = parseHighlightsEndDate(customEnd);

        if (startDate > endDate) {
          return res.status(400).json({ error: 'startDate must be before endDate' });
        }

        // Max 30 days range
        const diffDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
        if (diffDays > 30) {
          return res.status(400).json({ error: 'Date range must be 30 days or less' });
        }
      } else {
        // Default: last 7 days
        endDate = new Date();
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 7);
      }

      const correlationId = randomUUID();
      const startDateStr = startDate.toISOString().split('T')[0];
      const endDateStr = endDate.toISOString().split('T')[0];

      // For dry run, query the release notes the worker would summarize and return a preview without dispatching
      if (dryRun) {
        const releaseNotes = await loadHighlightsReleaseNotes({ start: startDate, end: endDate }, req.logger);
        const entries = releaseNotes.kind === 'ok' ? releaseNotes.entries : [];

        return res.json({
          success: true,
          dryRun: true,
          skipped: releaseNotes.kind === 'disabled',
          message:
            releaseNotes.kind === 'disabled'
              ? 'Dry run complete: release notes are disabled, so generation would be skipped'
              : releaseNotes.truncated
                ? `Dry run complete: the range holds more than ${entries.length} release notes; only the newest ${entries.length} would be summarized`
                : `Dry run complete: found ${entries.length} release notes`,
          truncated: releaseNotes.kind === 'ok' && releaseNotes.truncated,
          dateRange: { startDate: startDateStr, endDate: endDateStr },
          modalCount: entries.length,
          modals: entries.map(entry => ({
            title: entry.title,
            subtitle: entry.subtitle,
            descriptionPreview: entry.description.substring(0, 200),
            createdAt: entry.createdAt,
          })),
        });
      }

      const payload: WhatsNewHighlightsPayload = {
        correlationId,
        environment: Resource.App.stage === 'production' ? 'production' : 'dev',
        startDate: startDateStr,
        endDate: endDateStr,
        slackChannelId: config.slackChannelId,
        slackTeamId: config.slackTeamId,
        manualTrigger: true,
      };

      // Dispatch to queue
      // Type assertion needed: SST types are generated after first deploy
      const queueResource = (Resource as unknown as Record<string, { url: string } | undefined>)
        .whatsNewHighlightsQueue;
      if (!queueResource?.url) {
        return res.status(500).json({ error: 'whatsNewHighlightsQueue not deployed — SQS queue URL unavailable' });
      }
      await sendToQueue(queueResource.url, payload);

      // Update settings with dispatch info
      await AdminSettings.findOneAndUpdate(
        { settingName: SETTING_NAME },
        {
          $set: {
            'settingValue.lastRunAt': new Date().toISOString(),
            'settingValue.lastCorrelationId': correlationId,
            'settingValue.lastTriggeredBy': req.user.id,
            'settingValue.lastTriggerType': 'manual',
          },
        },
        { upsert: true }
      );

      return res.json({
        success: true,
        message: 'Highlights generation started',
        correlationId,
        dateRange: {
          startDate: startDateStr,
          endDate: endDateStr,
        },
      });
    } catch (error) {
      const log = new Logger({ metadata: { service: 'generateHighlights' } });
      log.error('Error triggering highlights generation:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({
        error: 'Failed to trigger highlights generation',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
