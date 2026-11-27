import { findVerifiedGitHubAccounts } from '@bike4mind/slack';
/**
 * GitHub Webhook - Issues Event Handler
 *
 * Handles `issues` events:
 *   - opened -> notify repo watchers (except issue author)
 *   - closed -> notify issue author (if closed by someone else)
 *   - assigned -> notify the assignee
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { extractErrorMessage } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubIssuesPayload,
  GitHubWebhookPayload,
} from '@bike4mind/server-utils/integrations/github/types';
import {
  GitHubSlackNotifier,
  NotifyResult,
  buildIssueOpenedBlocks,
  buildIssueClosedBlocks,
  buildIssueAssignedBlocks,
} from '@bike4mind/slack';
import { webhookSubscriptionRepository } from '@bike4mind/database';
import { emptyNotifyResult, mergeNotifyResults, toHandlerResult } from './notifyResultUtils';

export class IssuesHandler implements GitHubEventHandler {
  eventType = 'issues' as const;
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
    const issues = payload as GitHubIssuesPayload;
    const repo = issues.repository?.full_name || 'unknown';
    let result: NotifyResult = emptyNotifyResult();

    this.logger?.info('[GITHUB-ISSUES] Processing issues event', {
      action: issues.action,
      issueNumber: issues.issue.number,
      repo,
      mcpServerId: mcpServer?.id,
    });

    const notifyOptions = { orgId: context?.orgId };

    switch (issues.action) {
      case 'opened':
        result = await this.handleOpened(issues, repo, notifyOptions);
        break;

      case 'closed':
        result = await this.handleClosed(issues, repo, notifyOptions);
        break;

      case 'assigned':
        result = await this.handleAssigned(issues, repo, notifyOptions);
        break;

      // 'unassigned' is intentionally not handled (low value notification)
    }

    return toHandlerResult(result);
  }

  private async handleOpened(
    issues: GitHubIssuesPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    const issueAuthor = issues.issue.user.login.toLowerCase();
    let combined: NotifyResult = emptyNotifyResult();
    const notifiedGitHubUsernames = new Set<string>(); // Track to avoid duplicate notifications

    // 1. Notify assignees (if any) - excluding the issue author
    const assigneeLogins = (issues.issue.assignees || [])
      .map(a => a.login)
      .filter(login => login.toLowerCase() !== issueAuthor);

    if (assigneeLogins.length > 0) {
      this.logger?.debug('[GITHUB-ISSUES] Notifying assignees for issue opened', {
        issueNumber: issues.issue.number,
        assigneeCount: assigneeLogins.length,
      });

      const assigneeResult = await this.notifier.notify(
        'issueOpened',
        assigneeLogins,
        () =>
          buildIssueOpenedBlocks({
            issueNumber: issues.issue.number,
            issueTitle: issues.issue.title,
            issueUrl: issues.issue.html_url,
            author: issues.issue.user.login,
            repo,
            body: issues.issue.body,
          }),
        options
      );
      combined = mergeNotifyResults(combined, assigneeResult);

      // Track notified assignees to avoid double-notifying as subscribers
      assigneeLogins.forEach(login => notifiedGitHubUsernames.add(login.toLowerCase()));
    }

    // 2. Notify org subscribers (if orgId present) - excluding author and already-notified assignees
    if (options?.orgId) {
      try {
        const subscribers = await webhookSubscriptionRepository.findByOrgAndRepo(options.orgId, repo);

        // Filter to subscribers who want 'issues' events
        const issueSubscribers = subscribers.filter(sub => sub.events.length === 0 || sub.events.includes('issues'));

        if (issueSubscribers.length === 0) {
          this.logger?.debug('[GITHUB-ISSUES] No subscribers want issues events', {
            orgId: options.orgId,
            repo,
          });
        } else {
          // Get the GitHub usernames of subscribers
          const subscriberUserIds = issueSubscribers.map(sub => sub.userId);
          const accounts = await findVerifiedGitHubAccounts({ userIds: subscriberUserIds });

          // Get GitHub usernames and filter out:
          // - The issue author (self-notification prevention)
          // - Already-notified assignees (deduplication)
          const targetGitHubUsernames = accounts
            .map(account => account.metadata?.githubLogin)
            .filter(
              (username): username is string =>
                username !== undefined &&
                username.toLowerCase() !== issueAuthor &&
                !notifiedGitHubUsernames.has(username.toLowerCase())
            );

          if (targetGitHubUsernames.length === 0) {
            this.logger?.debug('[GITHUB-ISSUES] No valid subscriber targets after filtering', {
              orgId: options.orgId,
              subscriberCount: issueSubscribers.length,
              issueAuthor: issues.issue.user.login,
            });
          } else {
            this.logger?.info('[GITHUB-ISSUES] Notifying subscribers for issue opened', {
              targetCount: targetGitHubUsernames.length,
              issueNumber: issues.issue.number,
            });

            const subscriberResult = await this.notifier.notify(
              'issueOpened',
              targetGitHubUsernames,
              () =>
                buildIssueOpenedBlocks({
                  issueNumber: issues.issue.number,
                  issueTitle: issues.issue.title,
                  issueUrl: issues.issue.html_url,
                  author: issues.issue.user.login,
                  repo,
                  body: issues.issue.body,
                }),
              { orgId: options.orgId }
            );
            combined = mergeNotifyResults(combined, subscriberResult);
          }
        }
      } catch (error) {
        this.logger?.error('[GITHUB-ISSUES] Failed to process subscriber notifications for issue opened', {
          orgId: options.orgId,
          repo,
          issueNumber: issues.issue.number,
          error,
        });
        // Keep partial results from the assignee loop, but surface the
        // subscriber-lookup failure as dispatchError so the queue handler
        // records Failed instead of falling through to Skipped.
        combined = mergeNotifyResults(combined, {
          notifiedUserIds: [],
          failedNotifications: [],
          dispatchError: `Subscriber lookup failed: ${extractErrorMessage(error)}`,
        });
      }
    }

    return combined;
  }

  private async handleClosed(
    issues: GitHubIssuesPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    const issueAuthor = issues.issue.user.login;
    const closedBy = issues.sender?.login || 'unknown';

    // Only notify the author if someone else closed the issue
    if (issueAuthor.toLowerCase() === closedBy.toLowerCase()) {
      this.logger?.debug('[GITHUB-ISSUES] Author closed their own issue, skipping notification');
      return emptyNotifyResult();
    }

    return this.notifier.notify(
      'issueClosed',
      [issueAuthor],
      () =>
        buildIssueClosedBlocks({
          issueNumber: issues.issue.number,
          issueTitle: issues.issue.title,
          issueUrl: issues.issue.html_url,
          closedBy,
          repo,
        }),
      options
    );
  }

  private async handleAssigned(
    issues: GitHubIssuesPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    // The assignee is in issues.assignee for the 'assigned' action
    const assignee = issues.assignee?.login;
    if (!assignee) {
      this.logger?.debug('[GITHUB-ISSUES] No assignee in payload');
      return emptyNotifyResult();
    }

    const assignedBy = issues.sender?.login || 'unknown';

    // Don't notify if user assigned themselves
    if (assignee.toLowerCase() === assignedBy.toLowerCase()) {
      this.logger?.debug('[GITHUB-ISSUES] User assigned themselves, skipping notification');
      return emptyNotifyResult();
    }

    return this.notifier.notify(
      'issueAssigned',
      [assignee],
      (user: { slackUserId?: string }) =>
        buildIssueAssignedBlocks({
          issueNumber: issues.issue.number,
          issueTitle: issues.issue.title,
          issueUrl: issues.issue.html_url,
          assignee,
          assignedBy,
          repo,
          assigneeSlackId: user.slackUserId,
        }),
      options
    );
  }
}
