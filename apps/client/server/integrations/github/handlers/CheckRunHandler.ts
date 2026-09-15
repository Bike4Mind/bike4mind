/**
 * GitHub Webhook - Check Run Event Handler
 *
 * Handles `check_run` events by logging them for observability.
 *
 * NOTE: Notifications are intentionally NOT sent from this handler to avoid
 * duplicate notifications. CI failures are notified via WorkflowRunHandler
 * which provides a single, comprehensive notification per workflow failure.
 * Check runs fire for each individual check (could be many per workflow),
 * leading to notification spam if we notify here.
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubCheckRunPayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier } from '@bike4mind/slack';

export class CheckRunHandler implements GitHubEventHandler {
  eventType = 'check_run' as const;
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
    const checkRun = payload as GitHubCheckRunPayload;
    const repo = checkRun.repository?.full_name || 'unknown';
    const notifiedUserIds: string[] = [];

    this.logger?.info('[GITHUB-CHECK-RUN] Processing check_run event', {
      action: checkRun.action,
      checkName: checkRun.check_run.name,
      status: checkRun.check_run.status,
      conclusion: checkRun.check_run.conclusion,
      repo,
      mcpServerId: mcpServer?.id,
    });

    // Log failures for observability but don't notify
    // (WorkflowRunHandler handles CI failure notifications to avoid spam)
    if (checkRun.action === 'completed') {
      const conclusion = checkRun.check_run.conclusion;
      if (conclusion === 'failure' || conclusion === 'timed_out') {
        this.logger?.info('[GITHUB-CHECK-RUN] Check failed (notification via workflow_run)', {
          checkName: checkRun.check_run.name,
          conclusion,
          commitSha: checkRun.check_run.head_sha,
          repo,
        });
      }
    }

    return { notifiedUserIds };
  }
}
