/**
 * SRE Tracking Rerun API - POST /api/sre/tracking/:id/rerun
 *
 * Rerun a dismissed tracking doc from scratch. Distinct from Retry (which works
 * on failed/wont_fix/etc. terminal states). Rerun is specifically for dismissed
 * docs - it preserves the dismissed doc as audit history and creates a brand new
 * tracking doc via claimForAnalysis.
 *
 * Behavior:
 *   1. Verify admin + doc exists + status === 'dismissed'
 *   2. Pre-check circuit breaker (reject if tripped, with actionable guidance)
 *   3. For GITHUB_ISSUE sources: verify the GitHub issue is still open
 *   4. Clear the sre-dispatch-{repoSlug}:{fingerprint} dedup cache
 *   5. Dispatch a fresh event (webhook path for GITHUB_ISSUE, SQS for CLOUDWATCH)
 *   6. Return dispatch result with normalized user-facing message
 *
 * Unlike retry, does NOT delete the dismissed doc - the audit trail (reason,
 * dismissedAt, dismissedByUserId) is preserved. The new tracking doc is linked
 * back to the dismissed one via `originatingFromDismissedDocId` (populated in
 * claimForAnalysis when it detects a dismissed predecessor).
 *
 * Race condition note: Concurrent rerun calls for the same doc both clear the
 * cache and dispatch. The second dispatch hits the fingerprint-level dedup
 * (re-populated by the first) and returns 'already-dispatched' - safe, no
 * duplicate side effects.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { sreErrorTrackingRepository, cacheRepository, adminSettingsRepository } from '@bike4mind/database';
import {
  SreAgentConfigSchema,
  SreSourceType,
  SreClassification,
  SRE_DEFAULT_REPO_SLUG,
  resolveFullConfig,
} from '@bike4mind/common';
import type { SreEventPayload, SreJobType } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import {
  dispatchIssueToSre,
  parseIssueNumberFromUrl,
  type SreIssuePayload,
} from '@server/integrations/github/sreWebhookDispatch';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendToQueue } from '@server/utils/sqs';
import { Logger } from '@bike4mind/observability';

/**
 * Normalize internal dispatch reason codes to user-facing messages.
 * Keeps implementation details out of the UI layer.
 */
const DISPATCH_REASON_MESSAGES: Record<string, string> = {
  'pipeline-disabled': 'SRE pipeline is disabled in config',
  'github-source-disabled': 'GitHub source is disabled in config',
  'repo-mismatch': 'Issue repository does not match configured target repo',
  'label-mismatch': 'Issue labels no longer match the SRE filter — check GitHub labels and SRE config',
  'already-dispatched': 'Fingerprint dispatched within the last hour (dedup cache). Try again later.',
};

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundError('Invalid tracking ID');
    }

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    if (doc.status !== 'dismissed') {
      res.status(409).json({
        message: `Rerun is only available from 'dismissed' state (current: ${doc.status}). Use Retry for other terminal states.`,
      });
      return;
    }

    const logger = new Logger({ metadata: { component: 'sre-rerun', userId: req.user.id } });
    const { errorFingerprint: fingerprint, source } = doc;
    const repoSlug = doc.repoSlug ?? SRE_DEFAULT_REPO_SLUG;

    // Load config (for CB check + GitHub config downstream)
    const rawConfig = await adminSettingsRepository.getSettingsValue('sreAgentConfig');
    const config = SreAgentConfigSchema.parse(rawConfig ?? {});

    // Per-repo enabled check
    const repoConfig = resolveFullConfig(config, repoSlug);
    if (!repoConfig) {
      res.status(409).json({ message: 'Repo not configured in SRE config' });
      return;
    }
    if (!repoConfig.enabled) {
      res.status(409).json({ message: 'SRE pipeline is disabled in config' });
      return;
    }

    // Pre-check circuit breaker (per-repo) - prevent "clicked
    // Rerun but failed instantly" UX. Matches the check in queue handlers.
    const cooldown = repoConfig.circuitBreaker.cooldownMinutes;
    const repoFailures = await sreErrorTrackingRepository.countConsecutiveFailures(repoSlug, cooldown);
    if (repoFailures >= repoConfig.circuitBreaker.failureThreshold) {
      res.status(409).json({
        message: `Circuit breaker open (repo: ${repoFailures}). Dismiss other recent failures before retrying a rerun.`,
        repoFailures,
        threshold: repoConfig.circuitBreaker.failureThreshold,
      });
      return;
    }

    if (source === SreSourceType.GITHUB_ISSUE) {
      const systemRepo = repoSlug;

      const issueNumber = doc.githubIssueNumber ?? parseIssueNumberFromUrl(doc.sourceRef);

      if (!systemRepo || !issueNumber) {
        res.status(409).json({ message: 'Missing GitHub config or issue number for rerun' });
        return;
      }

      const githubService = await GitHubService.forSystem(logger);
      if (!githubService) {
        res.status(500).json({ message: 'GitHub service unavailable' });
        return;
      }

      const issue = await githubService.getIssue(systemRepo, issueNumber);
      if (!issue) {
        res.status(404).json({ message: `GitHub issue #${issueNumber} not found` });
        return;
      }

      if (issue.state === 'closed') {
        res.status(409).json({ message: 'Cannot rerun: GitHub issue is closed' });
        return;
      }

      // Clear dispatch dedup before re-dispatch (mirrors retry.ts pattern)
      await cacheRepository.deleteByKey(`sre-dispatch-${repoSlug}:${fingerprint}`);

      const payload: SreIssuePayload = {
        action: 'rerun',
        issue: {
          title: issue.title,
          number: issue.number,
          html_url: issue.html_url,
          body: issue.body,
          labels: issue.labels.map(l => ({ name: l.name })),
        },
        repository: { full_name: systemRepo },
      };

      const result = await dispatchIssueToSre(payload, logger);

      // dispatchIssueToSre re-populates the dedup cache internally if it
      // dispatched. That's fine - it means any *further* event for this
      // fingerprint (webhook, etc.) will dedup normally.

      logger.info('[SRE-RERUN] Rerun initiated for GITHUB_ISSUE', {
        userId: req.user.id,
        trackingId: id,
        fingerprint,
        issueNumber,
        dispatched: result.dispatched,
        reason: result.reason,
      });

      const userMessage = result.dispatched
        ? 'Rerun dispatched — a new tracking doc will appear shortly'
        : (DISPATCH_REASON_MESSAGES[result.reason ?? ''] ?? 'Dispatch blocked');

      res.status(200).json({
        success: true,
        dispatched: result.dispatched,
        userMessage,
        code: result.reason ?? null,
        fingerprint,
      });
      return;
    }

    // CLOUDWATCH source - no GitHub lookups needed
    await cacheRepository.deleteByKey(`sre-dispatch-${repoSlug}:${fingerprint}`);

    const srePayload: SreEventPayload = {
      source: SreSourceType.CLOUDWATCH,
      fingerprint,
      repoSlug,
      classification: (doc.classification as SreClassification) || SreClassification.MEDIUM,
      errorMessage: doc.errorMessage || fingerprint,
      logGroup: doc.sourceRef || undefined,
    };

    await sendToQueue(getSourceQueueUrl('sreJobQueue'), {
      ...srePayload,
      jobType: 'analysis' satisfies SreJobType,
    } as unknown as Record<string, unknown>);

    logger.info('[SRE-RERUN] Rerun initiated for CLOUDWATCH', {
      userId: req.user.id,
      trackingId: id,
      fingerprint,
    });

    res.status(200).json({
      success: true,
      dispatched: true,
      userMessage: 'Rerun dispatched — a new tracking doc will appear shortly',
      code: null,
      fingerprint,
    });
  })
);

export default handler;
