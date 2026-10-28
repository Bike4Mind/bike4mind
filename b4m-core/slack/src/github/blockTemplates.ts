/**
 * Block Kit templates for GitHub-to-Slack notifications.
 * Pure functions - no side effects, no DB access.
 *
 * Each function returns { text, blocks } where text is the fallback
 * for notification previews and blocks is the rich Block Kit layout.
 */

import { escapeSlackCode, escapeSlackLine, escapeSlackText } from '@bike4mind/common';
import { KnownBlock } from '@slack/web-api';

interface BlockTemplateResult {
  text: string;
  blocks: KnownBlock[];
}

/**
 * Truncate text to max length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ─── PR Opened ─────────────────────────────────────────────────

interface PROpenedData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  author: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export function buildPROpenedBlocks(data: PROpenedData): BlockTemplateResult {
  const stats =
    data.additions !== undefined ? ` (+${data.additions} / -${data.deletions}, ${data.changedFiles} files)` : '';

  return {
    text: escapeSlackText(`[${data.repo}] PR #${data.prNumber} opened by ${data.author}: ${data.prTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `PR #${data.prNumber} Opened`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.prUrl}|${escapeSlackLine(data.prTitle)}>*\n${escapeSlackLine(data.headBranch)} → ${escapeSlackLine(data.baseBranch)}${stats}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Repo:* ${escapeSlackLine(data.repo)}  |  *Author:* ${escapeSlackLine(data.author)}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View PR', emoji: true },
            url: data.prUrl,
            action_id: 'github_view_pr',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Files', emoji: true },
            url: `${data.prUrl}/files`,
            action_id: 'github_view_files',
          },
        ],
      },
    ],
  };
}

// ─── Review Requested ──────────────────────────────────────────

interface ReviewRequestedData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  author: string;
  reviewer: string;
  repo: string;
  reviewerSlackId?: string;
}

export function buildReviewRequestedBlocks(data: ReviewRequestedData): BlockTemplateResult {
  const reviewerMention = data.reviewerSlackId ? `<@${data.reviewerSlackId}>` : escapeSlackLine(data.reviewer);

  return {
    text: escapeSlackText(`[${data.repo}] Review requested on PR #${data.prNumber}: ${data.prTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Review Requested', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${reviewerMention}, *${escapeSlackLine(data.author)}* requested your review on *<${data.prUrl}|#${data.prNumber} ${escapeSlackLine(data.prTitle)}>*`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Review PR', emoji: true },
            url: data.prUrl,
            style: 'primary',
            action_id: 'github_review_pr',
          },
        ],
      },
    ],
  };
}

// ─── PR Approved ───────────────────────────────────────────────

interface PRReviewData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  reviewer: string;
  repo: string;
  reviewBody?: string;
}

export function buildPRApprovedBlocks(data: PRReviewData): BlockTemplateResult {
  const bodyPreview = data.reviewBody ? `\n> ${escapeSlackLine(truncate(data.reviewBody, 200))}` : '';

  return {
    text: escapeSlackText(`[${data.repo}] PR #${data.prNumber} approved by ${data.reviewer}: ${data.prTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'PR Approved', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackLine(data.reviewer)}* approved *<${data.prUrl}|#${data.prNumber} ${escapeSlackLine(data.prTitle)}>*${bodyPreview}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
    ],
  };
}

// ─── PR Changes Requested ──────────────────────────────────────

export function buildPRChangesRequestedBlocks(data: PRReviewData): BlockTemplateResult {
  const bodyPreview = data.reviewBody ? `\n> ${escapeSlackLine(truncate(data.reviewBody, 200))}` : '';

  return {
    text: escapeSlackText(
      `[${data.repo}] Changes requested on PR #${data.prNumber} by ${data.reviewer}: ${data.prTitle}`
    ),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Changes Requested', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackLine(data.reviewer)}* requested changes on *<${data.prUrl}|#${data.prNumber} ${escapeSlackLine(data.prTitle)}>*${bodyPreview}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Review', emoji: true },
            url: data.prUrl,
            action_id: 'github_view_review',
          },
        ],
      },
    ],
  };
}

// ─── PR Merged ─────────────────────────────────────────────────

interface PRMergedData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  mergedBy: string;
  repo: string;
  baseBranch: string;
}

export function buildPRMergedBlocks(data: PRMergedData): BlockTemplateResult {
  return {
    text: escapeSlackText(`[${data.repo}] PR #${data.prNumber} merged by ${data.mergedBy}: ${data.prTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'PR Merged', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.prUrl}|#${data.prNumber} ${escapeSlackLine(data.prTitle)}>* merged into \`${escapeSlackCode(data.baseBranch)}\` by *${escapeSlackLine(data.mergedBy)}*`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
    ],
  };
}

// ─── CI Failed ─────────────────────────────────────────────────

interface CIData {
  workflowName: string;
  workflowUrl: string;
  branch: string;
  repo: string;
  commitMessage?: string;
  commitAuthor?: string;
  runNumber: number;
}

export function buildCIFailedBlocks(data: CIData): BlockTemplateResult {
  const commitInfo = data.commitMessage ? `\nCommit: _${escapeSlackLine(data.commitMessage.split('\n')[0])}_` : '';

  return {
    text: escapeSlackText(`[${data.repo}] CI failed: ${data.workflowName} on ${data.branch}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'CI Failed', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.workflowUrl}|${escapeSlackLine(data.workflowName)}>* failed on \`${escapeSlackCode(data.branch)}\` (run #${data.runNumber})${commitInfo}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Repo:* ${escapeSlackLine(data.repo)}${data.commitAuthor ? `  |  *Author:* ${escapeSlackLine(data.commitAuthor)}` : ''}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Run', emoji: true },
            url: data.workflowUrl,
            style: 'danger',
            action_id: 'github_view_ci_run',
          },
        ],
      },
    ],
  };
}

// ─── CI Passed ─────────────────────────────────────────────────

export function buildCIPassedBlocks(data: CIData): BlockTemplateResult {
  return {
    text: escapeSlackText(`[${data.repo}] CI passed: ${data.workflowName} on ${data.branch}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'CI Passed', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.workflowUrl}|${escapeSlackLine(data.workflowName)}>* passed on \`${escapeSlackCode(data.branch)}\` (run #${data.runNumber})`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
    ],
  };
}

// ─── @Mention ──────────────────────────────────────────────────

interface MentionData {
  commentUrl: string;
  commentBody: string;
  commenter: string;
  issueOrPrNumber: number;
  issueOrPrTitle: string;
  issueOrPrUrl: string;
  repo: string;
  isPullRequest: boolean;
}

export function buildMentionBlocks(data: MentionData): BlockTemplateResult {
  const type = data.isPullRequest ? 'PR' : 'Issue';
  const bodyPreview = escapeSlackLine(truncate(data.commentBody, 300));

  return {
    text: escapeSlackText(
      `[${data.repo}] ${data.commenter} mentioned you in ${type} #${data.issueOrPrNumber}: ${data.issueOrPrTitle}`
    ),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Mentioned in ${type} Comment`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackLine(data.commenter)}* mentioned you in *<${data.issueOrPrUrl}|#${data.issueOrPrNumber} ${escapeSlackLine(data.issueOrPrTitle)}>*\n> ${bodyPreview}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Comment', emoji: true },
            url: data.commentUrl,
            action_id: 'github_view_comment',
          },
        ],
      },
    ],
  };
}

// ─── Push Commits ──────────────────────────────────────────────

interface PushData {
  repo: string;
  branch: string;
  pusher: string;
  compareUrl: string;
  commitCount: number;
  commits: Array<{
    sha: string;
    message: string;
    author: string;
    url: string;
  }>;
  forced: boolean;
}

/**
 * Truncate commit message to 72 chars (git convention) and escape for mrkdwn
 */
function truncateCommitMessage(message: string): string {
  const firstLine = message.split('\n')[0];
  const truncated = firstLine.length > 72 ? firstLine.slice(0, 69) + '...' : firstLine;
  return escapeSlackLine(truncated);
}

export function buildPushBlocks(data: PushData): BlockTemplateResult {
  const displayCommits = data.commits.slice(0, 3);
  const commitList = displayCommits
    .map(c => `<${c.url}|\`${c.sha.slice(0, 7)}\`> ${truncateCommitMessage(c.message)}`)
    .join('\n');

  const moreCommits = data.commitCount > 3 ? `\n_...and ${data.commitCount - 3} more commits_` : '';

  const forceWarning = data.forced ? '\n:warning: *Force pushed*' : '';

  const headerText = data.forced ? 'Force Push' : `Push to ${data.branch}`;

  return {
    text: escapeSlackText(`[${data.repo}] ${data.commitCount} commit(s) pushed to ${data.branch} by ${data.pusher}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackLine(data.pusher)}* pushed ${data.commitCount} commit${data.commitCount > 1 ? 's' : ''} to \`${escapeSlackCode(data.branch)}\`${forceWarning}\n\n${commitList}${moreCommits}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Changes', emoji: true },
            url: data.compareUrl,
            style: 'primary',
            action_id: 'github_view_push',
          },
        ],
      },
    ],
  };
}

// ─── Issue Opened ──────────────────────────────────────────────

interface IssueData {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  author: string;
  repo: string;
  body?: string;
}

export function buildIssueOpenedBlocks(data: IssueData): BlockTemplateResult {
  const bodyPreview = data.body ? `\n> ${escapeSlackLine(truncate(data.body, 200))}` : '';

  return {
    text: escapeSlackText(`[${data.repo}] Issue #${data.issueNumber} opened by ${data.author}: ${data.issueTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Issue #${data.issueNumber} Opened`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.issueUrl}|${escapeSlackLine(data.issueTitle)}>*${bodyPreview}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*Repo:* ${escapeSlackLine(data.repo)}  |  *Author:* ${escapeSlackLine(data.author)}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Issue', emoji: true },
            url: data.issueUrl,
            action_id: 'github_view_issue',
          },
        ],
      },
    ],
  };
}

// ─── Issue Closed ──────────────────────────────────────────────

interface IssueClosedData {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  closedBy: string;
  repo: string;
}

export function buildIssueClosedBlocks(data: IssueClosedData): BlockTemplateResult {
  return {
    text: escapeSlackText(`[${data.repo}] Issue #${data.issueNumber} closed by ${data.closedBy}: ${data.issueTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `Issue #${data.issueNumber} Closed`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${data.issueUrl}|${escapeSlackLine(data.issueTitle)}>* closed by *${escapeSlackLine(data.closedBy)}*`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
    ],
  };
}

// ─── Issue Assigned ────────────────────────────────────────────

interface IssueAssignedData {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  assignee: string;
  assignedBy: string;
  repo: string;
  assigneeSlackId?: string;
}

export function buildIssueAssignedBlocks(data: IssueAssignedData): BlockTemplateResult {
  const assigneeMention = data.assigneeSlackId ? `<@${data.assigneeSlackId}>` : escapeSlackLine(data.assignee);

  return {
    text: escapeSlackText(`[${data.repo}] Issue #${data.issueNumber} assigned to ${data.assignee}: ${data.issueTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Issue Assigned', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${assigneeMention}, you've been assigned to *<${data.issueUrl}|#${data.issueNumber} ${escapeSlackLine(data.issueTitle)}>* by *${escapeSlackLine(data.assignedBy)}*`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Issue', emoji: true },
            url: data.issueUrl,
            style: 'primary',
            action_id: 'github_view_assigned_issue',
          },
        ],
      },
    ],
  };
}

// ─── PR Review Comment ─────────────────────────────────────────

interface PRReviewCommentData {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  commentUrl: string;
  commenter: string;
  commentBody: string;
  repo: string;
  path: string;
}

export function buildPRReviewCommentBlocks(data: PRReviewCommentData): BlockTemplateResult {
  const bodyPreview = escapeSlackLine(truncate(data.commentBody, 200));
  const escapedPath = escapeSlackLine(data.path);

  return {
    text: escapeSlackText(`[${data.repo}] ${data.commenter} commented on PR #${data.prNumber}: ${data.prTitle}`),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'PR Review Comment', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${escapeSlackLine(data.commenter)}* commented on *<${data.prUrl}|#${data.prNumber} ${escapeSlackLine(data.prTitle)}>*\n_${escapedPath}_\n> ${bodyPreview}`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Repo:* ${escapeSlackLine(data.repo)}` }],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Comment', emoji: true },
            url: data.commentUrl,
            action_id: 'github_view_pr_comment',
          },
        ],
      },
    ],
  };
}
