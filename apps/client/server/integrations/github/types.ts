/**
 * GitHub Webhook Integration - Types
 *
 * Type definitions for GitHub webhook event handling.
 */

import { IMcpServerDocument } from '@bike4mind/common';

/**
 * Supported GitHub webhook event types
 */
export const SUPPORTED_GITHUB_EVENTS = [
  'ping',
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issues',
  'issue_comment',
  'workflow_run',
  'check_run',
  'check_suite',
] as const;

export type GitHubEventType = (typeof SUPPORTED_GITHUB_EVENTS)[number];

/**
 * Check if a string is a valid GitHub event type
 */
export function isValidGitHubEventType(eventType: string): eventType is GitHubEventType {
  return SUPPORTED_GITHUB_EVENTS.includes(eventType as GitHubEventType);
}

/**
 * Common repository structure in GitHub webhook payloads
 */
export interface GitHubRepository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: {
    login: string;
    id: number;
    node_id: string;
    type: string;
  };
  private: boolean;
  html_url: string;
}

/**
 * Common sender structure in GitHub webhook payloads
 */
export interface GitHubSender {
  login: string;
  id: number;
  node_id: string;
  type: string;
  html_url: string;
}

/**
 * Base structure for all GitHub webhook payloads
 */
export interface GitHubWebhookPayload {
  action?: string;
  repository?: GitHubRepository;
  sender?: GitHubSender;
}

/**
 * Ping event payload (sent when webhook is first configured)
 */
export interface GitHubPingPayload extends GitHubWebhookPayload {
  zen: string;
  hook_id: number;
  hook: {
    type: string;
    id: number;
    name: string;
    active: boolean;
    events: string[];
    config: {
      content_type: string;
      url: string;
    };
  };
}

/**
 * Pull request event payload
 */
export interface GitHubPullRequestPayload extends GitHubWebhookPayload {
  action: 'opened' | 'closed' | 'reopened' | 'synchronize' | 'review_requested' | string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string; id: number; html_url: string };
    merged: boolean;
    merged_by?: { login: string; id: number; html_url: string };
    head: { ref: string; sha: string };
    base: { ref: string };
    additions?: number;
    deletions?: number;
    changed_files?: number;
    requested_reviewers?: Array<{ login: string; id: number }>;
  };
  requested_reviewer?: { login: string; id: number };
}

/**
 * Pull request review event payload
 */
export interface GitHubPullRequestReviewPayload extends GitHubWebhookPayload {
  action: 'submitted' | 'edited' | 'dismissed' | string;
  review: {
    id: number;
    state: 'approved' | 'changes_requested' | 'commented' | 'dismissed' | string;
    user: { login: string; id: number; html_url: string };
    html_url: string;
    body?: string;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string; id: number; html_url: string };
    /** Branch info - needed to detect sre-fix/* branches for revision handling */
    head?: { ref: string; sha: string };
  };
}

/**
 * Workflow run event payload
 */
export interface GitHubWorkflowRunPayload extends GitHubWebhookPayload {
  action: 'completed' | 'requested' | 'in_progress' | string;
  workflow_run: {
    id: number;
    name: string;
    conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | null | string;
    html_url: string;
    head_branch: string;
    head_sha: string;
    head_commit?: {
      message: string;
      author: { name: string; email: string };
    };
    actor: { login: string; id: number; html_url: string };
    run_number: number;
    run_attempt: number;
  };
}

/**
 * Issue comment event payload
 */
export interface GitHubIssueCommentPayload extends GitHubWebhookPayload {
  action: 'created' | 'edited' | 'deleted' | string;
  comment: {
    id: number;
    body: string;
    user: { login: string; id: number; html_url: string };
    html_url: string;
    created_at: string;
  };
  issue: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string; id: number };
    pull_request?: { url: string; html_url: string };
  };
}

/**
 * Push event payload
 */
export interface GitHubPushPayload extends GitHubWebhookPayload {
  ref: string; // e.g., "refs/heads/main"
  before: string; // SHA before push
  after: string; // SHA after push
  created: boolean; // New branch?
  deleted: boolean; // Branch deleted?
  forced: boolean; // Force push?
  compare: string; // Comparison URL
  commits: Array<{
    id: string; // Commit SHA
    message: string;
    timestamp: string; // ISO 8601
    url: string;
    author: { name: string; email: string; username?: string };
    committer: { name: string; email: string; username?: string };
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
    timestamp: string;
    url: string;
    author: { name: string; email: string; username?: string };
  } | null;
  pusher: { name: string; email: string };
}

/**
 * Issues event payload
 */
export interface GitHubIssuesPayload extends GitHubWebhookPayload {
  action: 'opened' | 'closed' | 'reopened' | 'assigned' | 'unassigned' | 'labeled' | 'unlabeled' | 'edited' | string;
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: 'open' | 'closed';
    user: { login: string; id: number; html_url: string };
    assignee?: { login: string; id: number; html_url: string };
    assignees?: Array<{ login: string; id: number }>;
    labels?: Array<{ name: string; color: string }>;
    body?: string;
    created_at: string;
    closed_at?: string;
    closed_by?: { login: string; id: number };
  };
  assignee?: { login: string; id: number; html_url: string };
}

/**
 * Pull request review comment event payload
 */
export interface GitHubPullRequestReviewCommentPayload extends GitHubWebhookPayload {
  action: 'created' | 'edited' | 'deleted' | string;
  comment: {
    id: number;
    body: string;
    user: { login: string; id: number; html_url: string };
    html_url: string;
    path: string;
    commit_id: string;
    created_at: string;
  };
  pull_request: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string; id: number; html_url: string };
    head: { ref: string; sha: string };
    base: { ref: string };
  };
}

/**
 * Check run event payload
 */
export interface GitHubCheckRunPayload extends GitHubWebhookPayload {
  action: 'created' | 'completed' | 'rerequested' | 'requested_action' | string;
  check_run: {
    id: number;
    name: string;
    status: 'queued' | 'in_progress' | 'completed' | string;
    conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | null | string;
    html_url: string;
    head_sha: string;
    check_suite: {
      id: number;
      head_branch: string;
    };
    output?: {
      title: string;
      summary: string;
    };
    started_at?: string;
    completed_at?: string;
  };
}

/**
 * Check suite event payload
 */
export interface GitHubCheckSuitePayload extends GitHubWebhookPayload {
  action: 'completed' | 'requested' | 'rerequested' | string;
  check_suite: {
    id: number;
    head_branch: string;
    head_sha: string;
    status: 'queued' | 'in_progress' | 'completed' | string;
    conclusion: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' | null | string;
    url: string;
    before: string;
    after: string;
    pull_requests: Array<{
      number: number;
      url: string;
      head: { ref: string; sha: string };
      base: { ref: string };
    }>;
  };
}

/**
 * Context passed to handlers from the queue processor.
 * Carries org-level metadata so handlers can forward it to the notifier.
 */
export interface GitHubHandlerContext {
  orgId?: string;
}

/**
 * Result returned by event handlers, reporting notification outcomes.
 * Used by the queue handler to record accurate per-subscriber delivery status:
 *   - notifiedUserIds: Slack message confirmed delivered -> Success
 *   - failedNotifications: notification attempted but failed -> Failed
 *   - notificationDispatchError: pre-loop catastrophic failure (target enumeration,
 *     subscription check, bot token) -> all targeted subscribers recorded as Failed
 *
 * Users absent from both lists are intentionally not notified (e.g., wrong PR
 * reviewer, prefs disabled) and recorded as Skipped. This distinction ensures
 * a failed notification never appears as Skipped.
 */
export interface GitHubHandlerResult {
  notifiedUserIds: string[];
  failedNotifications?: Array<{ userId: string; error: string }>;
  notificationDispatchError?: string;
}

/**
 * Handler interface for GitHub webhook events
 */
export interface GitHubEventHandler {
  eventType: GitHubEventType;
  handle(
    payload: GitHubWebhookPayload,
    mcpServer?: IMcpServerDocument,
    context?: GitHubHandlerContext
  ): Promise<GitHubHandlerResult>;
}

/**
 * GitHub webhook headers
 */
export interface GitHubWebhookHeaders {
  'x-github-event': string;
  'x-github-delivery': string;
  'x-hub-signature-256': string;
  'x-webhook-token': string;
  'content-type': string;
}

/**
 * Result of webhook signature validation
 */
export interface SignatureValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Result of webhook processing
 */
export interface WebhookProcessingResult {
  success: boolean;
  message: string;
  eventType?: GitHubEventType;
  deliveryId?: string;
  error?: string;
}
