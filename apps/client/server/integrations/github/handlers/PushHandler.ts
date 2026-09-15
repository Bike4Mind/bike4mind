/**
 * GitHub Webhook - Push Event Handler
 *
 * Handles `push` events:
 *   - Commits pushed to protected branches (main, master, develop, release/*)
 *   - Notifies subscribers (except the pusher)
 *   - Special handling for force pushes
 *
 * Opt-in: Users must have 'push' in their subscription events filter
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { extractErrorMessage } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubPushPayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier, buildPushBlocks } from '@bike4mind/slack';
import { webhookSubscriptionRepository, User } from '@bike4mind/database';
import { emptyNotifyResult, toHandlerResult } from './notifyResultUtils';

// Protected branch patterns - only notify for pushes to these branches
const PROTECTED_BRANCH_PATTERNS = ['main', 'master', 'develop', 'release/'];

export class PushHandler implements GitHubEventHandler {
  eventType = 'push' as const;
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
    const push = payload as GitHubPushPayload;
    const repo = push.repository?.full_name || 'unknown';

    // Skip tag pushes (different use case)
    if (push.ref.startsWith('refs/tags/')) {
      this.logger?.debug('[GITHUB-PUSH] Skipping tag push', { ref: push.ref });
      return toHandlerResult(emptyNotifyResult());
    }

    // Extract branch name from ref (e.g., "refs/heads/main" -> "main")
    const branch = push.ref.replace('refs/heads/', '');

    this.logger?.info('[GITHUB-PUSH] Processing push event', {
      branch,
      commitCount: push.commits.length,
      forced: push.forced,
      created: push.created,
      deleted: push.deleted,
      repo,
      mcpServerId: mcpServer?.id,
    });

    // Handle branch deletion - skip notification for now
    if (push.deleted) {
      this.logger?.debug('[GITHUB-PUSH] Branch deleted, skipping notification', { branch });
      return toHandlerResult(emptyNotifyResult());
    }

    // Skip empty pushes (ref updates without commits)
    if (push.commits.length === 0 && !push.created) {
      this.logger?.debug('[GITHUB-PUSH] Empty push, skipping notification', { branch });
      return toHandlerResult(emptyNotifyResult());
    }

    // Only notify for protected branches
    if (!this.isProtectedBranch(branch)) {
      this.logger?.debug('[GITHUB-PUSH] Not a protected branch, skipping notification', {
        branch,
        protectedPatterns: PROTECTED_BRANCH_PATTERNS,
      });
      return toHandlerResult(emptyNotifyResult());
    }

    const pusher = push.pusher?.name || push.sender?.login || 'unknown';

    // For org webhooks, find all subscribers who have 'push' in their events
    // and notify them (except the pusher)
    if (context?.orgId) {
      try {
        const subscribers = await webhookSubscriptionRepository.findByOrgAndRepo(context.orgId, repo);

        const pushSubscribers = subscribers.filter(sub => sub.events.length === 0 || sub.events.includes('push'));

        if (pushSubscribers.length === 0) {
          this.logger?.debug('[GITHUB-PUSH] No subscribers want push events', { orgId: context.orgId, repo });
          return toHandlerResult(emptyNotifyResult());
        }

        const subscriberUserIds = pushSubscribers.map(sub => sub.userId);
        const users = await User.find({
          _id: { $in: subscriberUserIds },
          'slackSettings.githubNotifications.githubUsername': { $exists: true, $ne: '' },
          'slackSettings.githubNotifications.enabled': true,
        })
          .select('slackSettings.githubNotifications.githubUsername')
          .lean<Array<{ slackSettings?: { githubNotifications?: { githubUsername?: string } } }>>();

        // Get GitHub usernames and filter out the pusher
        const pusherLower = pusher.toLowerCase();
        const targetGitHubUsernames = users
          .map(u => u.slackSettings?.githubNotifications?.githubUsername)
          .filter((username): username is string => username !== undefined && username.toLowerCase() !== pusherLower);

        if (targetGitHubUsernames.length === 0) {
          this.logger?.debug('[GITHUB-PUSH] No valid targets after filtering', {
            orgId: context.orgId,
            subscriberCount: pushSubscribers.length,
            pusher,
          });
          return toHandlerResult(emptyNotifyResult());
        }

        const pushData = {
          repo,
          branch,
          pusher,
          compareUrl: push.compare,
          commitCount: push.commits.length,
          commits: push.commits.map(c => ({
            sha: c.id,
            message: c.message,
            author: c.author.username || c.author.name || 'unknown',
            url: c.url,
          })),
          forced: push.forced,
        };

        this.logger?.info('[GITHUB-PUSH] Notifying subscribers', {
          targetCount: targetGitHubUsernames.length,
          branch,
          commitCount: push.commits.length,
          forced: push.forced,
        });

        const result = await this.notifier.notify(
          'pushCommits',
          targetGitHubUsernames,
          () => buildPushBlocks(pushData),
          { orgId: context.orgId }
        );

        return toHandlerResult(result);
      } catch (error) {
        this.logger?.error('[GITHUB-PUSH] Failed to process push notification', {
          orgId: context.orgId,
          repo,
          branch,
          error,
        });
        // Surface as dispatchError so the queue handler records this as Failed.
        // Without it, the classifier falls through to Skipped and the failure is
        // invisible in the DLQ dashboard.
        return toHandlerResult({
          notifiedUserIds: [],
          failedNotifications: [],
          dispatchError: `Subscriber lookup failed: ${extractErrorMessage(error)}`,
        });
      }
    }

    return toHandlerResult(emptyNotifyResult());
  }

  /**
   * Check if a branch matches any protected branch pattern
   */
  private isProtectedBranch(branch: string): boolean {
    return PROTECTED_BRANCH_PATTERNS.some(pattern => {
      if (pattern.endsWith('/')) {
        // Pattern like "release/" matches "release/1.0", "release/anything"
        return branch.startsWith(pattern);
      }
      return branch === pattern;
    });
  }
}
