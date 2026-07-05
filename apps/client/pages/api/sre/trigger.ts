/**
 * SRE Manual Trigger API - POST /api/sre/trigger
 *
 * Allows admins to manually dispatch GitHub issues to the SRE pipeline.
 * Accepts issue numbers individually or in batch, with label validation enforced.
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { adminSettingsRepository, sreErrorTrackingRepository, cacheRepository } from '@bike4mind/database';
import { SreAgentConfigSchema, getConfiguredRepoSlugs, resolveFullConfig } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import {
  matchesLabelFilter,
  dispatchIssueToSre,
  computeIssueFingerprint,
  type SreIssuePayload,
  type SreDispatchResult,
} from '@server/integrations/github/sreWebhookDispatch';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';

const TriggerRequestSchema = z.object({
  issueNumbers: z.array(z.number().int().positive()).min(1).max(20),
  /** Target repo slug (owner/repo). Falls back to first configured repo. */
  repoSlug: z.string().optional(),
});

interface TriggerResultItem {
  issueNumber: number;
  dispatched: boolean;
  reason?: string;
  labels?: string[];
}

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const parsed = TriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(`Invalid request: ${parsed.error.issues.map(i => i.message).join(', ')}`);
    }

    const issueNumbers = [...new Set(parsed.data.issueNumbers)];
    const logger = new Logger({ metadata: { component: 'sre-trigger', userId: req.user.id } });

    logger.info('[SRE-TRIGGER] Manual trigger requested', {
      userId: req.user.id,
      issueCount: issueNumbers.length,
    });

    // Load config once
    const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
    const config = SreAgentConfigSchema.parse(rawConfig ?? {});

    // Resolve target repo from request body or first configured repo
    const configuredRepos = getConfiguredRepoSlugs(config);
    const systemRepo = parsed.data.repoSlug || configuredRepos[0] || '';

    if (!systemRepo) {
      throw new BadRequestError('SRE config missing github owner/repo');
    }

    // Check per-repo enablement and GitHub source enablement
    const repoConfig = resolveFullConfig(config, systemRepo);
    if (!repoConfig) {
      res.status(200).json({
        results: issueNumbers.map(n => ({ issueNumber: n, dispatched: false, reason: 'repo-not-configured' })),
      });
      return;
    }
    if (!repoConfig.enabled) {
      res.status(200).json({
        results: issueNumbers.map(n => ({ issueNumber: n, dispatched: false, reason: 'repo-disabled' })),
      });
      return;
    }
    if (!repoConfig.sources.github.enabled) {
      res.status(200).json({
        results: issueNumbers.map(n => ({ issueNumber: n, dispatched: false, reason: 'github-source-disabled' })),
      });
      return;
    }

    const githubService = await GitHubService.forSystem(logger);
    if (!githubService) {
      throw new BadRequestError('GitHub service unavailable — check system GitHub connection');
    }

    const results: TriggerResultItem[] = [];

    // Process sequentially to avoid thundering herd on GitHub API
    for (const issueNumber of issueNumbers) {
      try {
        const issue = await githubService.getIssue(systemRepo, issueNumber);
        if (!issue) {
          results.push({ issueNumber, dispatched: false, reason: 'not-found' });
          continue;
        }

        const labels = issue.labels.map(l => l.name);
        if (!matchesLabelFilter(labels, repoConfig.sources.github.labelFilter)) {
          results.push({ issueNumber, dispatched: false, reason: 'label-mismatch', labels });
          continue;
        }

        const payload: SreIssuePayload = {
          action: 'manual-trigger',
          issue: {
            title: issue.title,
            number: issue.number,
            html_url: issue.html_url,
            body: issue.body,
            labels: issue.labels.map(l => ({ name: l.name })),
          },
          repository: { full_name: systemRepo },
        };

        const fingerprint = computeIssueFingerprint(issue.title);

        // Clear dispatch dedup cache so dispatchIssueToSre can proceed (repo-scoped)
        await cacheRepository.deleteByKey(`sre-dispatch-${systemRepo}:${fingerprint}`);

        const dispatchResult: SreDispatchResult = await dispatchIssueToSre(payload, logger);

        // Delete terminal tracking docs after successful queue send
        if (dispatchResult.dispatched) {
          const { deletedCount } = await sreErrorTrackingRepository.deleteTerminalByFingerprint(
            fingerprint,
            systemRepo
          );
          // Clear dedup cache again (dispatch recreated it)
          await cacheRepository.deleteByKey(`sre-dispatch-${systemRepo}:${fingerprint}`);
          if (deletedCount > 0) {
            logger.info('[SRE-TRIGGER] Cleared stale tracking docs', { fingerprint, deletedCount });
          }
        }

        results.push({
          issueNumber,
          dispatched: dispatchResult.dispatched,
          reason: dispatchResult.reason,
        });

        logger.info('[SRE-TRIGGER] Issue processed', {
          issueNumber,
          dispatched: dispatchResult.dispatched,
          reason: dispatchResult.reason,
        });
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403 || status === 429) {
          // Rate limited - mark remaining issues and stop
          results.push({ issueNumber, dispatched: false, reason: 'rate-limit-exceeded' });
          for (const remaining of issueNumbers.slice(issueNumbers.indexOf(issueNumber) + 1)) {
            results.push({ issueNumber: remaining, dispatched: false, reason: 'rate-limit-exceeded' });
          }
          break;
        }
        logger.error('[SRE-TRIGGER] Error processing issue', { issueNumber, error });
        results.push({ issueNumber, dispatched: false, reason: 'internal-error' });
      }
    }

    res.status(200).json({ results });
  })
);

export default handler;
