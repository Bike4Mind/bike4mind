/**
 * GitHub Webhook - Issue Comment Event Handler
 *
 * Handles `issue_comment` events:
 *   - created -> scan body for @username mentions -> notify mentioned users
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubIssueCommentPayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier, buildMentionBlocks } from '@bike4mind/slack';
import { toHandlerResult } from './notifyResultUtils';

/** Match @username but not email addresses (preceded by non-@ non-word char or start of line) */
const MENTION_REGEX = /(?:^|(?<=\s))@([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})/g;

export class IssueCommentHandler implements GitHubEventHandler {
  eventType = 'issue_comment' as const;
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
    const comment = payload as GitHubIssueCommentPayload;
    const repo = comment.repository?.full_name || 'unknown';

    this.logger?.info('[GITHUB-COMMENT] Processing issue_comment event', {
      action: comment.action,
      issueNumber: comment.issue.number,
      repo,
      mcpServerId: mcpServer?.id,
    });

    if (comment.action !== 'created') return { notifiedUserIds: [] };

    const commenter = comment.comment.user.login;
    const body = comment.comment.body || '';

    const mentions = new Set<string>();
    let match;
    while ((match = MENTION_REGEX.exec(body)) !== null) {
      const mentioned = match[1];
      // Don't notify the commenter about their own mention
      if (mentioned.toLowerCase() !== commenter.toLowerCase()) {
        mentions.add(mentioned);
      }
    }

    if (mentions.size === 0) return { notifiedUserIds: [] };

    const isPullRequest = Boolean(comment.issue.pull_request);

    const result = await this.notifier.notify(
      'mentions',
      Array.from(mentions),
      () =>
        buildMentionBlocks({
          commentUrl: comment.comment.html_url,
          commentBody: body,
          commenter,
          issueOrPrNumber: comment.issue.number,
          issueOrPrTitle: comment.issue.title,
          issueOrPrUrl: comment.issue.html_url,
          repo,
          isPullRequest,
        }),
      { orgId: context?.orgId }
    );

    return toHandlerResult(result);
  }
}
