/**
 * POST /api/sre/scan
 *
 * Finds open GitHub issues matching the configured label filter that have not yet been
 * processed by the SRE pipeline, and dispatches them.
 *
 * IMPORTANT: Unlike /api/sre/trigger (which explicitly clears the dispatch dedup cache
 * for a force-redispatch), this endpoint RESPECTS the existing dedup window. If an issue
 * was dispatched within the past hour, it is classified as skipped_recently_dispatched
 * rather than re-dispatched. This is intentional - scan is for discovery, not override.
 * Do not add a cacheRepository.deleteByKey() before dispatchIssueToSre() calls here.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { adminSettingsRepository, sreErrorTrackingRepository, cacheRepository } from '@bike4mind/database';
import { classifyForScan } from '@bike4mind/database/infra';
import { SreAgentConfigSchema, resolveFullConfig } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import {
  matchesLabelFilter,
  dispatchIssueToSre,
  computeIssueFingerprint,
  type SreIssuePayload,
} from '@server/integrations/github/sreWebhookDispatch';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const ScanRequestSchema = z.object({
  repoSlug: z.string().regex(/^[a-zA-Z0-9._-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/),
});

type ScanOutcome =
  | 'dispatched'
  | 'skipped_in_flight'
  | 'skipped_resolved'
  | 'skipped_dismissed'
  | 'skipped_recently_dispatched'
  | 'skipped_rate_limited'
  | 'skipped_dispatch_error'
  | 'skipped_cap_reached';

interface ScanResultItem {
  issueNumber: number;
  title: string;
  htmlUrl: string;
  outcome: ScanOutcome;
  reason?: string;
  trackingStatus?: string;
}

export interface ScanResponse {
  repoSlug: string;
  scanned: number;
  dispatched: number;
  capReached: boolean;
  skipped: {
    inFlight: number;
    resolved: number;
    dismissed: number;
    recentlyDispatched: number;
    rateLimited: number;
    dispatchError: number;
    capReached: number;
  };
  results: ScanResultItem[];
  durationMs: number;
}

const MAX_DISPATCH_PER_SCAN = 10;
const GITHUB_PAGE_SIZE = 100;
// 50s < 60s Lambda timeout - ensures the finally block has time to run before SIGKILL
const SCAN_MUTEX_TTL_MS = 50_000;

const handler = baseApi()
  .use(csrfProtection())
  .use(rateLimit({ limit: 3, windowMs: 60_000 }))
  .post(
    asyncHandler(async (req, res) => {
      if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

      const { repoSlug } = ScanRequestSchema.parse(req.body);
      const startTime = Date.now();
      const logger = new Logger({ metadata: { component: 'sre-scan', userId: req.user.id } });

      const lock = await cacheRepository.claimDedup(`sre-scan-mutex:${repoSlug}`, {}, SCAN_MUTEX_TTL_MS);
      if (!lock.claimed) {
        return res.status(429).json({ message: 'Scan already in progress for this repository — try again shortly' });
      }

      try {
        const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
        const config = SreAgentConfigSchema.parse(rawConfig ?? {});
        const repoConfig = resolveFullConfig(config, repoSlug);

        if (!repoConfig) throw new BadRequestError('Repository not configured in SRE config');
        if (!repoConfig.enabled) throw new BadRequestError('SRE Agent is disabled for this repository');
        if (!repoConfig.sources.github.enabled)
          throw new BadRequestError('GitHub source is disabled for this repository');

        const { required = [], anyOf = [] } = repoConfig.sources.github.labelFilter ?? {};
        if (required.length === 0 && anyOf.length === 0) {
          throw new BadRequestError(
            'Label filter would match all issues — add at least one label to the config before scanning'
          );
        }

        const githubService = await GitHubService.forSystem(logger);
        if (!githubService) throw new BadRequestError('GitHub service unavailable — check system GitHub connection');

        let batch;
        try {
          batch = await githubService.listIssues(repoSlug, {
            state: 'open',
            labels: required.length ? required.join(',') : undefined,
            per_page: GITHUB_PAGE_SIZE,
            page: 1,
            sort: 'created',
            direction: 'asc',
          });
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 403 || status === 429) {
            return res.status(502).json({ message: 'GitHub API rate limit or permission error — try again later' });
          }
          throw err;
        }

        const issues = batch.filter(issue =>
          matchesLabelFilter(
            issue.labels.map(l => l.name),
            repoConfig.sources.github.labelFilter
          )
        );

        const fingerprints = issues.map(issue => computeIssueFingerprint(issue.title));
        const trackingMap = await sreErrorTrackingRepository.findLatestByFingerprintBatch(fingerprints, repoSlug);
        const todayCount = await sreErrorTrackingRepository.countFixesDispatchedToday(repoSlug);
        const dailyLimit = repoConfig.maxFixesPerDay ?? Infinity;

        let dispatched = 0;
        const results: ScanResultItem[] = [];

        for (const issue of issues) {
          const fingerprint = computeIssueFingerprint(issue.title);
          const common = {
            issueNumber: issue.number,
            title: issue.title.slice(0, 200),
            htmlUrl: issue.html_url,
          };

          try {
            const existing = trackingMap.get(fingerprint);

            if (existing) {
              const classification = classifyForScan(existing.status);
              if (classification === 'in-flight') {
                results.push({ ...common, outcome: 'skipped_in_flight', trackingStatus: existing.status });
                continue;
              }
              if (classification === 'resolved') {
                results.push({ ...common, outcome: 'skipped_resolved', trackingStatus: existing.status });
                continue;
              }
              if (classification === 'dismissed') {
                results.push({ ...common, outcome: 'skipped_dismissed', trackingStatus: existing.status });
                continue;
              }
              // 'open' (RETRYABLE_STATUSES, dry_run) - clear terminal doc BEFORE dispatching so
              // claimForAnalysis on the SQS consumer doesn't race with this delete and no-op.
              // Matches the trigger.ts/retry.ts pattern.
              await sreErrorTrackingRepository.deleteTerminalByFingerprint(fingerprint, repoSlug);
            }

            if (todayCount + dispatched >= dailyLimit) {
              results.push({ ...common, outcome: 'skipped_rate_limited' });
              continue;
            }
            if (dispatched >= MAX_DISPATCH_PER_SCAN) {
              results.push({ ...common, outcome: 'skipped_cap_reached' });
              continue;
            }

            const payload: SreIssuePayload = {
              action: 'manual-trigger',
              issue: {
                title: issue.title,
                number: issue.number,
                html_url: issue.html_url,
                body: issue.body ?? undefined,
                labels: issue.labels.map(l => ({ name: l.name })),
              },
              repository: { full_name: repoSlug },
            };

            const dispatchResult = await dispatchIssueToSre(payload, logger);

            if (dispatchResult.dispatched) {
              dispatched += 1;
              results.push({ ...common, outcome: 'dispatched' });
            } else if (dispatchResult.reason === 'already-dispatched') {
              results.push({ ...common, outcome: 'skipped_recently_dispatched', reason: dispatchResult.reason });
            } else {
              results.push({ ...common, outcome: 'skipped_dispatch_error', reason: dispatchResult.reason });
            }
          } catch (err) {
            logger.error('[SRE-SCAN] Per-issue error', { fingerprint, issueNumber: issue.number, err });
            results.push({ ...common, outcome: 'skipped_dispatch_error', reason: 'internal-error' });
          }
        }

        const durationMs = Date.now() - startTime;
        const skipped = {
          inFlight: results.filter(r => r.outcome === 'skipped_in_flight').length,
          resolved: results.filter(r => r.outcome === 'skipped_resolved').length,
          dismissed: results.filter(r => r.outcome === 'skipped_dismissed').length,
          recentlyDispatched: results.filter(r => r.outcome === 'skipped_recently_dispatched').length,
          rateLimited: results.filter(r => r.outcome === 'skipped_rate_limited').length,
          dispatchError: results.filter(r => r.outcome === 'skipped_dispatch_error').length,
          capReached: results.filter(r => r.outcome === 'skipped_cap_reached').length,
        };
        const capReached = dispatched >= MAX_DISPATCH_PER_SCAN || skipped.capReached > 0;

        logger.info('[SRE-SCAN] complete', {
          repoSlug,
          adminUserId: req.user.id,
          scanned: issues.length,
          dispatched,
          durationMs,
        });

        res.status(200).json({
          repoSlug,
          scanned: issues.length,
          dispatched,
          capReached,
          skipped,
          results,
          durationMs,
        } satisfies ScanResponse);
      } finally {
        await cacheRepository.deleteByKey(`sre-scan-mutex:${repoSlug}`);
      }
    })
  );

export default handler;
