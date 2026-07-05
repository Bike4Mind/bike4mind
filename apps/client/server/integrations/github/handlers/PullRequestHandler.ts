/**
 * GitHub Webhook - Pull Request Event Handler
 *
 * Handles `pull_request` events:
 *   - opened -> notify repo subscribers
 *   - closed+merged -> notify PR merged
 *   - review_requested -> notify the requested reviewer
 */

import { IMcpServerDocument, InboxType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubPullRequestPayload,
  GitHubWebhookPayload,
} from '../types';
import {
  GitHubSlackNotifier,
  NotifyResult,
  buildPROpenedBlocks,
  buildPRMergedBlocks,
  buildReviewRequestedBlocks,
} from '@bike4mind/slack';
import { inboxRepository, sreErrorTrackingRepository } from '@bike4mind/database';
import { toHandlerResult } from './notifyResultUtils';

const EMPTY_NOTIFY_RESULT: NotifyResult = { notifiedUserIds: [], failedNotifications: [] };

export class PullRequestHandler implements GitHubEventHandler {
  eventType = 'pull_request' as const;
  private logger?: Logger;
  private notifier: GitHubSlackNotifier;

  constructor(notifier: GitHubSlackNotifier, logger?: Logger) {
    this.notifier = notifier;
    this.logger = logger;
  }

  async handle(
    payload: GitHubWebhookPayload,
    mcpServer?: IMcpServerDocument,
    context?: GitHubHandlerContext
  ): Promise<GitHubHandlerResult> {
    const pr = payload as GitHubPullRequestPayload;
    const repo = pr.repository?.full_name || 'unknown';

    this.logger?.info('[GITHUB-PR] Processing pull_request event', {
      action: pr.action,
      prNumber: pr.pull_request.number,
      repo,
      mcpServerId: mcpServer?.id,
    });

    const notifyOptions = { orgId: context?.orgId };

    let result: NotifyResult = EMPTY_NOTIFY_RESULT;
    switch (pr.action) {
      case 'opened':
        result = await this.handleOpened(pr, repo, notifyOptions);
        break;

      case 'closed':
        if (pr.pull_request.merged) {
          result = await this.handleMerged(pr, repo, notifyOptions);
        }
        break;

      case 'review_requested':
        result = await this.handleReviewRequested(pr, repo, notifyOptions);
        break;
    }

    return toHandlerResult(result);
  }

  private async handleOpened(
    pr: GitHubPullRequestPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    // Notify users who are NOT the author (they don't need notification for their own PR)
    const prAuthor = pr.pull_request.user.login.toLowerCase();

    // Notify requested reviewers if any
    const reviewerLogins = (pr.pull_request.requested_reviewers || []).map(r => r.login);

    if (reviewerLogins.length === 0) return EMPTY_NOTIFY_RESULT;

    return this.notifier.notify(
      'prOpened',
      reviewerLogins.filter(login => login.toLowerCase() !== prAuthor),
      () =>
        buildPROpenedBlocks({
          prNumber: pr.pull_request.number,
          prTitle: pr.pull_request.title,
          prUrl: pr.pull_request.html_url,
          author: pr.pull_request.user.login,
          repo,
          baseBranch: pr.pull_request.base.ref,
          headBranch: pr.pull_request.head.ref,
          additions: pr.pull_request.additions,
          deletions: pr.pull_request.deletions,
          changedFiles: pr.pull_request.changed_files,
        }),
      options
    );
  }

  private async handleMerged(
    pr: GitHubPullRequestPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    const prAuthor = pr.pull_request.user.login;
    const mergedBy = pr.pull_request.merged_by?.login || pr.sender?.login || 'unknown';

    // Notify the PR author that their PR was merged (unless they merged it themselves)
    const targets = prAuthor.toLowerCase() !== mergedBy.toLowerCase() ? [prAuthor] : [];

    const result: NotifyResult =
      targets.length > 0
        ? await this.notifier.notify(
            'prMerged',
            targets,
            () =>
              buildPRMergedBlocks({
                prNumber: pr.pull_request.number,
                prTitle: pr.pull_request.title,
                prUrl: pr.pull_request.html_url,
                mergedBy,
                repo,
                baseBranch: pr.pull_request.base.ref,
              }),
            options
          )
        : EMPTY_NOTIFY_RESULT;

    // SRE Concierge (Phase 1.5): Notify affected users when an SRE fix PR is merged
    try {
      const branchName = pr.pull_request.head.ref;
      if (branchName.startsWith('sre-fix/')) {
        const prNumber = pr.pull_request.number;
        const tracking = await sreErrorTrackingRepository.findByPrNumber(prNumber);
        if (tracking && tracking.affectedUserIds?.length > 0) {
          this.logger?.info('[SRE-CONCIERGE] SRE fix merged, notifying affected users', {
            prNumber,
            branchName,
            userCount: tracking.affectedUserIds.length,
          });
          await Promise.allSettled(
            tracking.affectedUserIds.map(affectedUserId =>
              inboxRepository.createInboxMessage({
                userId: 'SYSTEM',
                receiverId: affectedUserId,
                title: 'Bug fix deployed for an issue affecting you',
                message: `A fix for "${tracking.errorMessage?.slice(0, 200) || 'a production error'}" has been merged. The issue should be resolved shortly.`,
                type: InboxType.COMMON,
              })
            )
          );
          await sreErrorTrackingRepository.updateStatus(tracking.id, 'fixed', {
            fixMergedAt: new Date(),
            userNotifiedAt: new Date(),
          });
        }
      }
    } catch (err) {
      this.logger?.error('[SRE-CONCIERGE] Failed to process SRE fix merge notification', { error: err });
    }

    return result;
  }

  private async handleReviewRequested(
    pr: GitHubPullRequestPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    const reviewer = pr.requested_reviewer;
    if (!reviewer) return EMPTY_NOTIFY_RESULT;

    return this.notifier.notify(
      'prReviewRequested',
      [reviewer.login],
      (user: { slackUserId?: string }) =>
        buildReviewRequestedBlocks({
          prNumber: pr.pull_request.number,
          prTitle: pr.pull_request.title,
          prUrl: pr.pull_request.html_url,
          author: pr.pull_request.user.login,
          reviewer: reviewer.login,
          repo,
          reviewerSlackId: user.slackUserId,
        }),
      options
    );
  }
}
