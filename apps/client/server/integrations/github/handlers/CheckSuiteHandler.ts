/**
 * GitHub Webhook - Check Suite Event Handler
 *
 * Handles `check_suite` events by logging them for observability.
 *
 * NOTE: Notifications are intentionally NOT sent from this handler to avoid
 * duplicate notifications. CI failures are notified via WorkflowRunHandler
 * which provides a single, comprehensive notification per workflow failure.
 * Both check_suite and workflow_run events fire for CI failures, so notifying
 * from both would cause duplicate notifications.
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubCheckSuitePayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier } from '@bike4mind/slack';

export class CheckSuiteHandler implements GitHubEventHandler {
  eventType = 'check_suite' as const;
  private logger?: Logger;
  // Notifier kept for potential future use with deduplication
  private _notifier: GitHubSlackNotifier;

  constructor(notifier: GitHubSlackNotifier, logger?: Logger) {
    this._notifier = notifier;
    this.logger = logger;
  }

  async handle(
    payload: GitHubWebhookPayload,
    mcpServer?: IMcpServerDocument,
    _context?: GitHubHandlerContext
  ): Promise<GitHubHandlerResult> {
    const checkSuite = payload as GitHubCheckSuitePayload;
    const repo = checkSuite.repository?.full_name || 'unknown';
    const notifiedUserIds: string[] = [];

    this.logger?.info('[GITHUB-CHECK-SUITE] Processing check_suite event', {
      action: checkSuite.action,
      status: checkSuite.check_suite.status,
      conclusion: checkSuite.check_suite.conclusion,
      branch: checkSuite.check_suite.head_branch,
      repo,
      mcpServerId: mcpServer?.id,
    });

    // Log failures for observability but don't notify
    // (WorkflowRunHandler handles CI failure notifications to avoid spam)
    if (checkSuite.action === 'completed') {
      const conclusion = checkSuite.check_suite.conclusion;
      if (conclusion === 'failure' || conclusion === 'timed_out') {
        this.logger?.info('[GITHUB-CHECK-SUITE] Check suite failed (notification via workflow_run)', {
          conclusion,
          commitSha: checkSuite.check_suite.head_sha,
          branch: checkSuite.check_suite.head_branch,
          repo,
        });
      }
    }

    return { notifiedUserIds };
  }
}
