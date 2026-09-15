/**
 * GitHub Webhook - Pull Request Review Event Handler
 *
 * Handles `pull_request_review` events:
 *   - submitted + approved -> notify PR author
 *   - submitted + changes_requested -> notify PR author + SRE revision detection
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { extractErrorMessage } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubPullRequestReviewPayload,
  GitHubWebhookPayload,
} from '../types';
import {
  GitHubSlackNotifier,
  NotifyResult,
  buildPRApprovedBlocks,
  buildPRChangesRequestedBlocks,
} from '@bike4mind/slack';
import { toHandlerResult } from './notifyResultUtils';

export class PullRequestReviewHandler implements GitHubEventHandler {
  eventType = 'pull_request_review' as const;
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
    const review = payload as GitHubPullRequestReviewPayload;
    const repo = review.repository?.full_name || 'unknown';

    this.logger?.info('[GITHUB-REVIEW] Processing pull_request_review event', {
      action: review.action,
      state: review.review.state,
      prNumber: review.pull_request.number,
      repo,
      mcpServerId: mcpServer?.id,
    });

    if (review.action !== 'submitted') return { notifiedUserIds: [] };

    const prAuthor = review.pull_request.user.login;
    const reviewer = review.review.user.login;

    // Don't notify the PR author if they reviewed their own PR
    if (prAuthor.toLowerCase() === reviewer.toLowerCase()) return { notifiedUserIds: [] };

    const notifyOptions = { orgId: context?.orgId };

    let result: NotifyResult = { notifiedUserIds: [], failedNotifications: [] };

    switch (review.review.state) {
      case 'approved':
        result = await this.safeNotify(
          () =>
            this.notifier.notify(
              'prApproved',
              [prAuthor],
              () =>
                buildPRApprovedBlocks({
                  prNumber: review.pull_request.number,
                  prTitle: review.pull_request.title,
                  prUrl: review.pull_request.html_url,
                  reviewer,
                  repo,
                  reviewBody: review.review.body,
                }),
              notifyOptions
            ),
          'prApproved'
        );
        break;

      case 'changes_requested':
        result = await this.safeNotify(
          () =>
            this.notifier.notify(
              'prChangesRequested',
              [prAuthor],
              () =>
                buildPRChangesRequestedBlocks({
                  prNumber: review.pull_request.number,
                  prTitle: review.pull_request.title,
                  prUrl: review.pull_request.html_url,
                  reviewer,
                  repo,
                  reviewBody: review.review.body,
                }),
              notifyOptions
            ),
          'prChangesRequested'
        );
        break;
    }

    return toHandlerResult(result);
  }

  /**
   * The notifier honors a "never throws" contract (DI resolution is wrapped),
   * so this is belt-and-suspenders for any future code path inside the notifier
   * that might miss a try/catch - webhook processing always survives, and the
   * failure is reported back via `dispatchError`.
   */
  private async safeNotify(fn: () => Promise<NotifyResult>, eventType: string): Promise<NotifyResult> {
    try {
      return await fn();
    } catch (error) {
      const message = extractErrorMessage(error);
      this.logger?.error('[GITHUB-REVIEW] Notification dispatch threw (non-fatal)', {
        eventType,
        error,
      });
      return {
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: `Notifier threw: ${message}`,
      };
    }
  }
}
