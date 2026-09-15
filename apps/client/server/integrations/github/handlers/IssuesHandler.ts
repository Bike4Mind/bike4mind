/**
 * GitHub Webhook - Issues Event Handler
 *
 * Handles `issues` events:
 *   - opened -> notify repo watchers (except issue author) + dispatch to SRE
 *   - closed -> notify issue author (if closed by someone else)
 *   - assigned -> notify the assignee
 *   - labeled -> dispatch to SRE if labels now match the filter
 *   - reopened -> dispatch to SRE so the fix-loop guard can detect "fix didn't work"
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
} from '../types';
import {
  GitHubSlackNotifier,
  NotifyResult,
  buildIssueOpenedBlocks,
  buildIssueClosedBlocks,
  buildIssueAssignedBlocks,
} from '@bike4mind/slack';
import { webhookSubscriptionRepository, User } from '@bike4mind/database';
import { dispatchIssueToSre, syncSreIssueStateFromWebhook } from '../sreWebhookDispatch';
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

      case 'labeled':
        await this.handleLabeled(issues, repo);
        break;

      case 'reopened':
        await this.handleReopened(issues, repo);
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
          const users = await User.find({
            _id: { $in: subscriberUserIds },
            'slackSettings.githubNotifications.githubUsername': { $exists: true, $ne: '' },
            'slackSettings.githubNotifications.enabled': true,
          })
            .select('slackSettings.githubNotifications.githubUsername')
            .lean<Array<{ slackSettings?: { githubNotifications?: { githubUsername?: string } } }>>();

          // Get GitHub usernames and filter out:
          // - The issue author (self-notification prevention)
          // - Already-notified assignees (deduplication)
          const targetGitHubUsernames = users
            .map(u => u.slackSettings?.githubNotifications?.githubUsername)
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

    // SRE Sentinel: dispatch opened issue if label filter matches
    try {
      await this.dispatchToSreIfMatching(issues, repo);
    } catch (error) {
      this.logger?.error('[SRE-SENTINEL] Failed to dispatch opened issue to SRE pipeline', {
        issueNumber: issues.issue.number,
        repo,
        error,
      });
      // SRE dispatch failure must not affect existing notification flow
    }

    return combined;
  }

  private async handleClosed(
    issues: GitHubIssuesPayload,
    repo: string,
    options?: { orgId?: string }
  ): Promise<NotifyResult> {
    // Keep the denormalized githubIssueState fresh for the SRE admin filter.
    // Runs before the self-close early-return below so state is always recorded.
    await syncSreIssueStateFromWebhook(issues, this.logger);

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

  /**
   * Handle 'labeled' action - when a label is added to an existing issue,
   * check if the updated label set now matches the SRE filter and dispatch.
   */
  private async handleLabeled(issues: GitHubIssuesPayload, repo: string): Promise<void> {
    try {
      await this.dispatchToSreIfMatching(issues, repo);
    } catch (error) {
      this.logger?.error('[SRE-SENTINEL] Failed to dispatch labeled issue to SRE pipeline', {
        issueNumber: issues.issue.number,
        repo,
        error,
      });
      // SRE dispatch failure must not affect existing flows
    }
  }

  /**
   * Handle 'reopened' action - a reopened issue is the strongest "fix didn't
   * work" signal we have for SRE-tracked bugs. Dispatch to the same shared
   * path as `opened`; the fix-loop guard in `sreAnalysis.ts` detects the
   * prior fix on the same fingerprint and escalates to a human.
   */
  private async handleReopened(issues: GitHubIssuesPayload, repo: string): Promise<void> {
    // Record the reopen (issue is open again) before re-dispatching for analysis.
    await syncSreIssueStateFromWebhook(issues, this.logger);

    try {
      await this.dispatchToSreIfMatching(issues, repo);
    } catch (error) {
      this.logger?.error('[SRE-SENTINEL] Failed to dispatch reopened issue to SRE pipeline', {
        issueNumber: issues.issue.number,
        repo,
        error,
      });
      // SRE dispatch failure must not affect existing flows
    }
  }

  /**
   * Shared SRE dispatch logic for 'opened', 'labeled', and 'reopened' actions.
   * Delegates to the shared dispatchIssueToSre() function.
   */
  private async dispatchToSreIfMatching(issues: GitHubIssuesPayload, _repo: string): Promise<void> {
    await dispatchIssueToSre(issues, this.logger);
  }
}
