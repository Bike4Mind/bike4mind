/**
 * SRE Tracking Retry API - POST /api/sre/tracking/:id/retry
 *
 * Allows admins to retry analysis of a tracking document in a terminal state.
 * Clears dedup layers (dispatch cache + terminal tracking docs) and re-queues.
 *
 * Race condition note: If two admins retry the same doc concurrently, both may
 * succeed and send duplicate SQS messages. This is safe because downstream
 * claimForAnalysis uses $setOnInsert with a timestamp race check - only the
 * first consumer wins, the second gets null and no-ops.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { sreErrorTrackingRepository, cacheRepository, RETRYABLE_STATUSES } from '@bike4mind/database';
import { SreSourceType, SreClassification, SRE_DEFAULT_REPO_SLUG } from '@bike4mind/common';
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

const RETRYABLE_SET = new Set(RETRYABLE_STATUSES);

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundError('Invalid tracking ID');
    }

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    if (!RETRYABLE_SET.has(doc.status)) {
      res.status(409).json({ message: `Not in a retryable status (current: ${doc.status})` });
      return;
    }

    const logger = new Logger({ metadata: { component: 'sre-retry', userId: req.user.id } });
    const { errorFingerprint: fingerprint, source, status: previousStatus, repoSlug } = doc;
    const effectiveRepoSlug = repoSlug || SRE_DEFAULT_REPO_SLUG;

    if (source === 'GITHUB_ISSUE') {
      // Check if GitHub issue is closed before retrying
      const systemRepo = effectiveRepoSlug;

      const issueNumber = doc.githubIssueNumber ?? parseIssueNumberFromUrl(doc.sourceRef);

      if (!systemRepo || !issueNumber) {
        res.status(409).json({ message: 'Missing GitHub config or issue number for retry' });
        return;
      }

      // Backfill stale doc so issue-state and future retries work without re-parsing
      if (!doc.githubIssueNumber && issueNumber) {
        try {
          await sreErrorTrackingRepository.updateStatus(doc.id, doc.status, { githubIssueNumber: issueNumber });
        } catch (err) {
          logger.warn('[SRE-RETRY] Failed to backfill githubIssueNumber', { id: doc.id, err });
        }
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
        res.status(409).json({ message: 'Cannot retry: GitHub issue is closed' });
        return;
      }

      // Build fresh payload from live issue data and dispatch
      const payload: SreIssuePayload = {
        action: 'retry',
        issue: {
          title: issue.title,
          number: issue.number,
          html_url: issue.html_url,
          body: issue.body,
          labels: issue.labels.map(l => ({ name: l.name })),
        },
        repository: { full_name: systemRepo },
      };

      // Clear dispatch dedup before re-dispatch (repo-scoped)
      await cacheRepository.deleteByKey(`sre-dispatch-${effectiveRepoSlug}:${fingerprint}`);
      await dispatchIssueToSre(payload, logger);

      // Delete terminal docs after successful queue send
      const { deletedCount } = await sreErrorTrackingRepository.deleteTerminalByFingerprint(
        fingerprint,
        effectiveRepoSlug
      );
      // dispatchIssueToSre re-creates the dedup cache entry internally, so clear
      // it again to allow the queue handler's own dispatch path to proceed cleanly.
      await cacheRepository.deleteByKey(`sre-dispatch-${effectiveRepoSlug}:${fingerprint}`);

      logger.info('[SRE-RETRY] Terminal docs cleared for GH issue', { fingerprint, deletedCount });
    } else {
      // CLOUDWATCH source
      // Clear dispatch dedup (repo-scoped)
      await cacheRepository.deleteByKey(`sre-dispatch-${effectiveRepoSlug}:${fingerprint}`);

      const srePayload: SreEventPayload = {
        source: SreSourceType.CLOUDWATCH,
        fingerprint,
        repoSlug: effectiveRepoSlug,
        classification: (doc.classification as SreClassification) || SreClassification.MEDIUM,
        errorMessage: doc.errorMessage || fingerprint,
        logGroup: doc.sourceRef || undefined,
      };

      // Queue first, delete second - if SQS fails, doc still exists for retry
      await sendToQueue(getSourceQueueUrl('sreJobQueue'), {
        ...srePayload,
        jobType: 'analysis' satisfies SreJobType,
      } as unknown as Record<string, unknown>);
      const { deletedCount } = await sreErrorTrackingRepository.deleteTerminalByFingerprint(
        fingerprint,
        effectiveRepoSlug
      );
      logger.info('[SRE-RETRY] Terminal docs cleared for CW event', { fingerprint, deletedCount });
    }

    logger.info('[SRE-RETRY] Retry initiated', {
      userId: req.user.id,
      trackingId: id,
      fingerprint,
      source,
      previousStatus,
    });

    res.status(200).json({ success: true, fingerprint });
  })
);

export default handler;
