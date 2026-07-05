/**
 * GitHub Webhook - Workflow Run Event Handler
 *
 * Handles `workflow_run` events:
 *   - completed + failure -> notify commit author
 *   - completed + success -> notify commit author (if user opted in)
 */

import { IMcpServerDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  GitHubEventHandler,
  GitHubHandlerContext,
  GitHubHandlerResult,
  GitHubWorkflowRunPayload,
  GitHubWebhookPayload,
} from '../types';
import { GitHubSlackNotifier, NotifyResult, buildCIFailedBlocks, buildCIPassedBlocks } from '@bike4mind/slack';
import { toHandlerResult } from './notifyResultUtils';

export class WorkflowRunHandler implements GitHubEventHandler {
  eventType = 'workflow_run' as const;
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
    const wf = payload as GitHubWorkflowRunPayload;
    const repo = wf.repository?.full_name || 'unknown';
    let result: NotifyResult = { notifiedUserIds: [], failedNotifications: [] };

    this.logger?.info('[GITHUB-WORKFLOW] Processing workflow_run event', {
      action: wf.action,
      conclusion: wf.workflow_run.conclusion,
      workflow: wf.workflow_run.name,
      repo,
      mcpServerId: mcpServer?.id,
    });

    if (wf.action !== 'completed') return toHandlerResult(result);

    const actor = wf.workflow_run.actor.login;
    const ciData = {
      workflowName: wf.workflow_run.name,
      workflowUrl: wf.workflow_run.html_url,
      branch: wf.workflow_run.head_branch,
      repo,
      commitMessage: wf.workflow_run.head_commit?.message,
      commitAuthor: wf.workflow_run.head_commit?.author.name,
      runNumber: wf.workflow_run.run_number,
    };

    switch (wf.workflow_run.conclusion) {
      case 'failure':
        result = await this.notifier.notify('ciFailed', [actor], () => buildCIFailedBlocks(ciData), {
          isCI: true,
          orgId: context?.orgId,
        });
        break;

      case 'success':
        result = await this.notifier.notify('ciPassed', [actor], () => buildCIPassedBlocks(ciData), {
          isCI: true,
          orgId: context?.orgId,
        });
        break;
    }

    return toHandlerResult(result);
  }
}
