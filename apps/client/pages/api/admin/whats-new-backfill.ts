import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { AdminSettings, ModalModel } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import { collectDataForDate } from '@server/services/whatsNewDataCollector';
import { Logger } from '@bike4mind/observability';
import type { WhatsNewGenerationPayload } from '@server/queueHandlers/types';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';

// Rate limiting - 3 requests per minute to allow retries after gateway timeouts
const BACKFILL_RATE_LIMIT = 3;
const ONE_MINUTE_MS = 60 * 1000;

// Max dates per request - keep low to stay within CloudFront gateway timeout (~30s)
const MAX_DATES = 10;

const logger = new Logger({ metadata: { service: 'whatsNewBackfill' } });

const handler = baseApi()
  .use(rateLimit({ limit: BACKFILL_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { dates, dryRun } = req.body as { dates?: string[]; dryRun?: boolean };

    if (!dates || !Array.isArray(dates) || dates.length === 0) {
      return res.status(400).json({ error: 'dates array is required' });
    }

    if (dates.length > MAX_DATES) {
      return res.status(400).json({ error: `Maximum ${MAX_DATES} dates per request` });
    }

    // Validate date formats
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    for (const date of dates) {
      if (!dateRegex.test(date)) {
        return res.status(400).json({ error: `Invalid date format: ${date}. Must be YYYY-MM-DD` });
      }
    }

    // Sort chronologically
    const sortedDates = [...dates].sort();

    const results: {
      queued: string[];
      skipped: string[];
      noPRs: string[];
      failed: string[];
      details: Array<{ date: string; status: string; prCount?: number; reason?: string }>;
    } = {
      queued: [],
      skipped: [],
      noPRs: [],
      failed: [],
      details: [],
    };

    // Read repository config from AdminSettings
    const configSetting = await AdminSettings.findOne({ settingName: 'whatsNewConfig' });
    const configValue = configSetting?.settingValue as Record<string, unknown> | undefined;
    const repository = (configValue?.repository as string) || 'MillionOnMars/lumina5';
    const targetBranch = (configValue?.targetBranch as string) || 'main';

    // Process a single date - shared logic for both sequential and parallel paths
    const processDate = async (date: string): Promise<void> => {
      // Check idempotency - does a modal already exist for this date?
      const existing = await ModalModel.findOne({
        'generationMetadata.generatedDate': date,
        'generationMetadata.environment': Resource.App.stage === 'production' ? 'production' : 'dev',
      });

      if (existing) {
        results.skipped.push(date);
        results.details.push({ date, status: 'skipped', reason: 'Modal already exists' });
        return;
      }

      // Collect data from GitHub
      const collected = await collectDataForDate(date, logger, { repository, targetBranch });

      if (!collected) {
        results.failed.push(date);
        results.details.push({ date, status: 'failed', reason: 'GitHub API unavailable' });
        return;
      }

      if (collected.filteredPRCount === 0) {
        results.noPRs.push(date);
        results.details.push({
          date,
          status: 'no_prs',
          prCount: collected.rawPRCount,
          reason: `${collected.rawPRCount} raw PRs, 0 after filtering`,
        });
        return;
      }

      if (dryRun) {
        results.queued.push(date);
        results.details.push({
          date,
          status: 'would_generate',
          prCount: collected.filteredPRCount,
        });
        return;
      }

      // Build payload and send to queue
      const correlationId = randomUUID();
      const payload: WhatsNewGenerationPayload = {
        ...collected.payload,
        correlationId,
        environment: Resource.App.stage === 'production' ? 'production' : 'dev',
      };

      const queueUrl = getSourceQueueUrl('whatsNewGenerationQueue');
      await sendToQueue(queueUrl, payload as unknown as Record<string, unknown>);

      results.queued.push(date);
      results.details.push({
        date,
        status: 'queued',
        prCount: collected.filteredPRCount,
      });

      logger.info('[Backfill] Queued generation for date', {
        date,
        correlationId,
        prs: collected.filteredPRCount,
      });
    };

    // Process all dates concurrently - each date is independent.
    // generatedDate is set from the input date, not execution order,
    // so modals always display in the correct chronological order.
    await Promise.all(
      sortedDates.map(async date => {
        try {
          await processDate(date);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          results.failed.push(date);
          results.details.push({ date, status: 'failed', reason: errorMsg });
          logger.error('[Backfill] Error processing date', { date, error: errorMsg });
        }
      })
    );
    // Sort details back into chronological order after parallel execution
    results.details.sort((a, b) => a.date.localeCompare(b.date));

    // Audit logging
    await AdminSettings.findOneAndUpdate(
      { settingName: 'whatsNewBackfillAudit' },
      {
        $set: {
          'settingValue.lastTriggeredBy': req.user.id,
          'settingValue.lastTriggeredAt': new Date().toISOString(),
          'settingValue.lastDryRun': !!dryRun,
          'settingValue.lastDates': sortedDates,
          'settingValue.lastResults': {
            queued: results.queued.length,
            skipped: results.skipped.length,
            noPRs: results.noPRs.length,
            failed: results.failed.length,
          },
        },
      },
      { upsert: true }
    );

    return res.json({
      success: true,
      dryRun: !!dryRun,
      ...results,
    });
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
