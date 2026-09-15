/**
 * GitHub Webhook - Pull Request Review Comment Event Handler
 *
 * Handles `pull_request_review_comment` events:
 *   - created -> notify PR author (unless self-comment)
 *   - Also notify @mentioned users in the comment
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubPullRequestReviewCommentPayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier, NotifyResult, buildPRReviewCommentBlocks } from '@bike4mind/slack';
import { mergeNotifyResults, toHandlerResult } from './notifyResultUtils';

export class PullRequestReviewCommentHandler implements GitHubEventHandler {
  eventType = 'pull_request_review_comment' as const;
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
    const comment = payload as GitHubPullRequestReviewCommentPayload;
    const repo = comment.repository?.full_name || 'unknown';
    const empty: NotifyResult = { notifiedUserIds: [], failedNotifications: [] };

    this.logger?.info('[GITHUB-PR-COMMENT] Processing pull_request_review_comment event', {
      action: comment.action,
      prNumber: comment.pull_request.number,
      commenter: comment.comment.user.login,
      repo,
      mcpServerId: mcpServer?.id,
    });

    // Only handle 'created' action
    if (comment.action !== 'created') {
      return toHandlerResult(empty);
    }

    const commenter = comment.comment.user.login;
    const prAuthor = comment.pull_request.user.login;

    // Don't notify if the PR author is commenting on their own PR
    if (commenter.toLowerCase() === prAuthor.toLowerCase()) {
      this.logger?.debug('[GITHUB-PR-COMMENT] Author commenting on own PR, skipping notification');
      return toHandlerResult(empty);
    }

    const notifyOptions = { orgId: context?.orgId };

    // Notify the PR author
    const authorResult = await this.notifier.notify(
      'prReviewComment',
      [prAuthor],
      () =>
        buildPRReviewCommentBlocks({
          prNumber: comment.pull_request.number,
          prTitle: comment.pull_request.title,
          prUrl: comment.pull_request.html_url,
          commentUrl: comment.comment.html_url,
          commenter,
          commentBody: comment.comment.body,
          repo,
          path: comment.comment.path,
        }),
      notifyOptions
    );

    // Also notify any @mentioned users in the comment
    const mentionedUsers = this.extractMentions(comment.comment.body);
    const uniqueMentions = mentionedUsers.filter(
      u => u.toLowerCase() !== prAuthor.toLowerCase() && u.toLowerCase() !== commenter.toLowerCase()
    );

    const mentionResult: NotifyResult =
      uniqueMentions.length > 0
        ? await this.notifier.notify(
            'mentions',
            uniqueMentions,
            () =>
              buildPRReviewCommentBlocks({
                prNumber: comment.pull_request.number,
                prTitle: comment.pull_request.title,
                prUrl: comment.pull_request.html_url,
                commentUrl: comment.comment.html_url,
                commenter,
                commentBody: comment.comment.body,
                repo,
                path: comment.comment.path,
              }),
            notifyOptions
          )
        : empty;

    return toHandlerResult(mergeNotifyResults(authorResult, mentionResult));
  }

  /**
   * Extract @mentions from comment body.
   * Uses lookbehind to avoid matching email addresses (e.g., foo@bar.com).
   */
  private extractMentions(body: string): string[] {
    // Match @username but not email addresses (preceded by whitespace or start of line)
    const mentionRegex = /(?:^|(?<=\s))@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/g;
    const matches = body.matchAll(mentionRegex);
    const mentions: string[] = [];

    for (const match of matches) {
      mentions.push(match[1]);
    }

    return [...new Set(mentions)];
  }
}
