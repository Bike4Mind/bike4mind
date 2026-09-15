import { initializeSlackPackage } from '@server/integrations/slack/slackPackageInit';
initializeSlackPackage();

/**
 * GitHub Webhook Integration - Handler Registry
 *
 * Central registry for GitHub webhook event handlers.
 * New event handlers should be registered here.
 */

import { Logger } from '@bike4mind/observability';
import { GitHubEventHandler, GitHubEventType } from '../types';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import { PingHandler } from './PingHandler';
import { PullRequestHandler } from './PullRequestHandler';
import { PullRequestReviewHandler } from './PullRequestReviewHandler';
import { WorkflowRunHandler } from './WorkflowRunHandler';
import { IssueCommentHandler } from './IssueCommentHandler';
import { PushHandler } from './PushHandler';
import { IssuesHandler } from './IssuesHandler';
import { PullRequestReviewCommentHandler } from './PullRequestReviewCommentHandler';
import { CheckRunHandler } from './CheckRunHandler';
import { CheckSuiteHandler } from './CheckSuiteHandler';

/**
 * Create handler registry with all registered handlers
 *
 * @param logger - Optional logger to pass to handlers
 * @returns Map of event type to handler
 */
export function createHandlerRegistry(logger?: Logger): Map<GitHubEventType, GitHubEventHandler> {
  const registry = new Map<GitHubEventType, GitHubEventHandler>();

  const notifier = new GitHubSlackNotifier(logger || (console as unknown as Logger));

  const handlers: GitHubEventHandler[] = [
    new PingHandler(logger),
    new PullRequestHandler(notifier, logger),
    new PullRequestReviewHandler(notifier, logger),
    new WorkflowRunHandler(notifier, logger),
    new IssueCommentHandler(notifier, logger),
    new PushHandler(notifier, logger),
    new IssuesHandler(notifier, logger),
    new PullRequestReviewCommentHandler(notifier, logger),
    new CheckRunHandler(notifier, logger),
    new CheckSuiteHandler(notifier, logger),
  ];

  for (const handler of handlers) {
    registry.set(handler.eventType, handler);
  }

  return registry;
}

/**
 * Get a handler for a specific event type
 *
 * @param registry - Handler registry map
 * @param eventType - GitHub event type
 * @returns Handler if found, undefined otherwise
 */
export function getHandler(
  registry: Map<GitHubEventType, GitHubEventHandler>,
  eventType: string
): GitHubEventHandler | undefined {
  return registry.get(eventType as GitHubEventType);
}

export {
  PingHandler,
  PullRequestHandler,
  PullRequestReviewHandler,
  WorkflowRunHandler,
  IssueCommentHandler,
  PushHandler,
  IssuesHandler,
  PullRequestReviewCommentHandler,
  CheckRunHandler,
  CheckSuiteHandler,
};
