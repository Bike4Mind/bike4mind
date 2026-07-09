/**
 * SRE Tracking Issue State API - GET /api/sre/tracking/:id/issue-state
 *
 * Returns the current GitHub issue state for a tracking document.
 * Used by the UI to show "Issue Closed" chip and disable retry.
 */

import mongoose from 'mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, NotFoundError, BadRequestError } from '@server/utils/errors';
import { sreErrorTrackingRepository } from '@bike4mind/database';
import { parseIssueNumberFromUrl } from '@server/integrations/github/sreWebhookDispatch';
import { SRE_DEFAULT_REPO_SLUG } from '@bike4mind/common';
import { GitHubService } from '@server/services/githubService';
import { Logger } from '@bike4mind/observability';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user.isAdmin) throw new ForbiddenError('Permission denied');

    const { id } = req.query as Record<string, string>;
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
      throw new NotFoundError('Invalid tracking ID');
    }

    const doc = await sreErrorTrackingRepository.findFullById(id);
    if (!doc) throw new NotFoundError('Tracking document not found');

    const issueNumber = doc.githubIssueNumber ?? parseIssueNumberFromUrl(doc.sourceRef);

    if (doc.source !== 'GITHUB_ISSUE' || !issueNumber) {
      throw new BadRequestError('Not a GitHub issue tracking document');
    }

    const logger = new Logger({ metadata: { component: 'sre-issue-state' } });

    // Backfill stale doc so future requests work without re-parsing
    if (!doc.githubIssueNumber && issueNumber) {
      try {
        await sreErrorTrackingRepository.updateStatus(doc.id, doc.status, { githubIssueNumber: issueNumber });
      } catch (err) {
        logger.warn('[SRE-ISSUE-STATE] Failed to backfill githubIssueNumber', { id: doc.id, err });
      }
    }

    const systemRepo = doc.repoSlug ?? SRE_DEFAULT_REPO_SLUG;

    if (!systemRepo) {
      res.status(200).json({ state: 'unknown', error: 'github-not-configured' });
      return;
    }

    try {
      const githubService = await GitHubService.forSystem(logger);
      if (!githubService) {
        res.status(200).json({ state: 'unknown', error: 'github-unavailable' });
        return;
      }

      const issue = await githubService.getIssue(systemRepo, issueNumber);
      if (!issue) {
        res.status(200).json({ state: 'unknown', error: 'issue-not-found' });
        return;
      }

      // Self-heal the denormalized githubIssueState the admin filter relies on.
      // The webhook handlers are the primary freshness source, but this backfills
      // docs created before webhooks fired (or that missed a delivery): every time
      // a GitHub-issue card renders it fetches live state here, so viewing the
      // pipeline eventually reconciles stale/absent state without a cron sweep.
      if (issue.state === 'open' || issue.state === 'closed') {
        try {
          await sreErrorTrackingRepository.setGithubIssueState(systemRepo, issueNumber, issue.state);
          // The bulk update above is scoped by repoSlug; a doc missing repoSlug is
          // silently skipped (systemRepo fell back to the default, which won't match
          // an absent field). We hold this doc's id, so reconcile it directly as a
          // backstop for that edge - otherwise the viewed doc never self-heals.
          if (!doc.repoSlug) {
            await sreErrorTrackingRepository.setGithubIssueStateById(doc.id, issue.state);
          }
        } catch (err) {
          logger.warn('[SRE-ISSUE-STATE] Failed to persist githubIssueState', { id: doc.id, err });
        }
      }

      res.status(200).json({ state: issue.state, closedAt: issue.closed_at });
    } catch {
      res.status(200).json({ state: 'unknown', error: 'github-unavailable' });
    }
  })
);

export default handler;
