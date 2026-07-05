/**
 * Jira Webhook Response Formatters
 *
 * Transforms raw Jira webhook API responses into cleaner formats
 * with computed fields (like daysUntilExpiry).
 */

import {
  JiraWebhook,
  JiraWebhookListResponse,
  FormattedJiraWebhook,
  FormattedJiraWebhookList,
  JiraIssueWebhookEvent,
  JiraCommentWebhookEvent,
  JiraSprintWebhookEvent,
} from './types';

/**
 * Calculate days until a date.
 */
function daysUntil(dateString: string): number {
  const expirationDate = new Date(dateString);
  const now = new Date();
  const diffMs = expirationDate.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Format a single webhook response.
 */
export function formatWebhook(webhook: JiraWebhook): FormattedJiraWebhook {
  const daysUntilExpiry = daysUntil(webhook.expirationDate);

  return {
    id: webhook.id,
    events: webhook.events,
    jqlFilter: webhook.jqlFilter,
    expirationDate: webhook.expirationDate,
    daysUntilExpiry,
    isExpiringSoon: daysUntilExpiry < 7,
  };
}

/**
 * Format a webhook list response.
 */
export function formatWebhookList(response: JiraWebhookListResponse): FormattedJiraWebhookList {
  return {
    webhooks: response.values.map(formatWebhook),
    total: response.total,
    hasMore: !response.isLast,
  };
}

// ============================================================================
// ADF (Atlassian Document Format) Text Extraction
// ============================================================================

/**
 * Extract plain text from an ADF (Atlassian Document Format) document.
 * ADF is a tree of nodes; text lives in "text" type nodes.
 * Returns empty string for non-ADF or malformed input.
 */
export function extractAdfText(body: unknown, maxLength = 500): string {
  if (!body || typeof body !== 'object') return '';
  const doc = body as Record<string, unknown>;
  if (doc.type !== 'doc' || !Array.isArray(doc.content)) return '';

  const parts: string[] = [];
  let totalLength = 0;

  function walk(nodes: unknown[]): void {
    for (const node of nodes) {
      if (totalLength >= maxLength) return;
      if (!node || typeof node !== 'object') continue;
      const n = node as Record<string, unknown>;

      if (n.type === 'text' && typeof n.text === 'string') {
        const remaining = maxLength - totalLength;
        const text = n.text.slice(0, remaining);
        parts.push(text);
        totalLength += text.length;
      }

      if (Array.isArray(n.content)) {
        walk(n.content);
      }
    }
  }

  walk(doc.content as unknown[]);
  const result = parts.join('');
  if (totalLength >= maxLength) return result + '...';
  return result;
}

// ============================================================================
// Slack Message Formatting
// ============================================================================

/**
 * Escape Slack mrkdwn special characters in user-controlled content.
 * Prevents injection of active markdown (bold, italic, links, mentions, etc.)
 * when displaying untrusted data from Jira payloads in Slack messages.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '∗') // Replace with look-alike (full-width asterisk)
    .replace(/_/g, '＿') // Replace with look-alike (full-width low line)
    .replace(/~/g, '∼') // Replace with look-alike (tilde operator)
    .replace(/`/g, 'ˋ'); // Replace with look-alike (modifier letter grave)
}

/**
 * Priority emoji mapping.
 */
const PRIORITY_EMOJI: Record<string, string> = {
  Highest: ':red_circle:',
  High: ':large_orange_circle:',
  Medium: ':large_yellow_circle:',
  Low: ':large_green_circle:',
  Lowest: ':white_circle:',
};

/**
 * Get emoji for priority level.
 */
function getPriorityEmoji(priority?: string): string {
  if (!priority) return '';
  return PRIORITY_EMOJI[priority] || ':blue_circle:';
}

/**
 * Slack Block Kit message structure.
 */
export interface SlackMessage {
  blocks: SlackBlock[];
  text: string; // Fallback text for notifications
}

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: boolean } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string }; accessory?: SlackAccessory }
  | { type: 'context'; elements: Array<{ type: 'mrkdwn'; text: string }> }
  | { type: 'divider' }
  | { type: 'actions'; elements: SlackActionElement[] };

type SlackAccessory = { type: 'button'; text: { type: 'plain_text'; text: string }; url: string };

type SlackActionElement = {
  type: 'button';
  text: { type: 'plain_text'; text: string; emoji: boolean };
  url: string;
  style?: 'primary' | 'danger';
};

/**
 * Format an issue event for Slack.
 */
export function formatIssueEventForSlack(event: JiraIssueWebhookEvent, siteUrl: string): SlackMessage {
  const { issue, webhookEvent, user, changelog } = event;
  const { fields } = issue;

  const priorityEmoji = getPriorityEmoji(fields.priority?.name);
  const issueUrl = `${siteUrl}/browse/${issue.key}`;

  // Determine event action for header
  let action: string;
  let emoji: string;
  switch (webhookEvent) {
    case 'jira:issue_created':
      action = 'created';
      emoji = ':new:';
      break;
    case 'jira:issue_updated':
      action = 'updated';
      emoji = ':pencil2:';
      break;
    case 'jira:issue_deleted':
      action = 'deleted';
      emoji = ':wastebasket:';
      break;
    default:
      action = 'changed';
      emoji = ':bell:';
  }

  // Build changelog summary for updates
  let changelogText = '';
  if (changelog?.items && changelog.items.length > 0) {
    const changes = changelog.items
      .slice(0, 3) // Limit to 3 changes
      .map(item => {
        const from = escapeSlackMrkdwn(item.fromString || 'None');
        const to = escapeSlackMrkdwn(item.toString || 'None');
        if (item.field === 'status') {
          return `Status: ${from} → ${to}`;
        }
        if (item.field === 'assignee') {
          return `Assignee: ${escapeSlackMrkdwn(item.fromString || 'Unassigned')} → ${escapeSlackMrkdwn(item.toString || 'Unassigned')}`;
        }
        if (item.field === 'priority') {
          return `Priority: ${from} → ${to}`;
        }
        return `${escapeSlackMrkdwn(item.field)}: ${from} → ${to}`;
      });

    if (changes.length > 0) {
      changelogText = '\n' + changes.map(c => `• ${c}`).join('\n');
      if (changelog.items.length > 3) {
        changelogText += `\n_...and ${changelog.items.length - 3} more changes_`;
      }
    }
  }

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Issue ${action}: ${escapeSlackMrkdwn(issue.key)}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${issueUrl}|${escapeSlackMrkdwn(issue.key)}>* ${escapeSlackMrkdwn(fields.summary)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${priorityEmoji} *Priority:* ${escapeSlackMrkdwn(fields.priority?.name || 'None')}`,
          `*Status:* ${escapeSlackMrkdwn(fields.status.name)}`,
          `*Type:* ${escapeSlackMrkdwn(fields.issuetype.name)}`,
          `*Assignee:* ${escapeSlackMrkdwn(fields.assignee?.displayName || 'Unassigned')}`,
        ].join('  |  '),
      },
    },
  ];

  // Add changelog for updates
  if (changelogText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Changes:*${changelogText}`,
      },
    });
  }

  // Add context with user and project
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${escapeSlackMrkdwn(user?.displayName || 'Someone')} • ${escapeSlackMrkdwn(fields.project.name)} (${escapeSlackMrkdwn(fields.project.key)})`,
      },
    ],
  });

  // Add action button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'View in Jira',
          emoji: true,
        },
        url: issueUrl,
        style: 'primary',
      },
    ],
  });

  return {
    blocks,
    text: `${emoji} ${escapeSlackMrkdwn(issue.key)} ${action}: ${escapeSlackMrkdwn(fields.summary)}`,
  };
}

/**
 * Format a comment event for Slack.
 */
export function formatCommentEventForSlack(event: JiraCommentWebhookEvent, siteUrl: string): SlackMessage {
  const { issue, comment, webhookEvent } = event;

  const issueUrl = `${siteUrl}/browse/${issue.key}`;

  let action: string;
  let emoji: string;
  switch (webhookEvent) {
    case 'comment_created':
      action = 'commented on';
      emoji = ':speech_balloon:';
      break;
    case 'comment_updated':
      action = 'updated comment on';
      emoji = ':pencil:';
      break;
    case 'comment_deleted':
      action = 'deleted comment on';
      emoji = ':x:';
      break;
    default:
      action = 'commented on';
      emoji = ':speech_balloon:';
  }

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} ${escapeSlackMrkdwn(comment.author.displayName)} ${action} ${escapeSlackMrkdwn(issue.key)}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${issueUrl}|${escapeSlackMrkdwn(issue.key)}>* ${escapeSlackMrkdwn(issue.fields.summary)}`,
      },
    },
  ];

  // Add comment body preview (skip for deleted comments)
  if (webhookEvent !== 'comment_deleted') {
    const bodyText = extractAdfText(comment.body);
    if (bodyText) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${escapeSlackMrkdwn(bodyText).replace(/\n/g, '\n> ')}`,
        },
      });
    }
  }

  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${escapeSlackMrkdwn(issue.fields.project.name)} • ${escapeSlackMrkdwn(issue.fields.issuetype.name)}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View in Jira',
            emoji: true,
          },
          url: issueUrl,
          style: 'primary',
        },
      ],
    }
  );

  return {
    blocks,
    text: `${emoji} ${escapeSlackMrkdwn(comment.author.displayName)} ${action} ${escapeSlackMrkdwn(issue.key)}: ${escapeSlackMrkdwn(issue.fields.summary)}`,
  };
}

/**
 * Format a sprint event for Slack.
 */
export function formatSprintEventForSlack(event: JiraSprintWebhookEvent, siteUrl: string): SlackMessage {
  const { sprint, webhookEvent, user } = event;

  let action: string;
  let emoji: string;
  switch (webhookEvent) {
    case 'sprint_created':
      action = 'created';
      emoji = ':calendar:';
      break;
    case 'sprint_started':
      action = 'started';
      emoji = ':rocket:';
      break;
    case 'sprint_closed':
      action = 'completed';
      emoji = ':checkered_flag:';
      break;
    case 'sprint_updated':
      action = 'updated';
      emoji = ':pencil2:';
      break;
    case 'sprint_deleted':
      action = 'deleted';
      emoji = ':wastebasket:';
      break;
    default:
      action = 'changed';
      emoji = ':bell:';
  }

  const sprintUrl = `${siteUrl}/secure/RapidBoard.jspa?rapidView=${sprint.originBoardId}`;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Sprint ${action}: ${escapeSlackMrkdwn(sprint.name)}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*State:* ${escapeSlackMrkdwn(sprint.state)}`,
          sprint.startDate ? `*Start:* ${new Date(sprint.startDate).toLocaleDateString()}` : '',
          sprint.endDate ? `*End:* ${new Date(sprint.endDate).toLocaleDateString()}` : '',
        ]
          .filter(Boolean)
          .join('  |  '),
      },
    },
  ];

  if (sprint.goal) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Goal:* ${escapeSlackMrkdwn(sprint.goal)}`,
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: user?.displayName ? escapeSlackMrkdwn(user.displayName) : 'System',
      },
    ],
  });

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'View Board',
          emoji: true,
        },
        url: sprintUrl,
        style: 'primary',
      },
    ],
  });

  return {
    blocks,
    text: `${emoji} Sprint ${action}: ${escapeSlackMrkdwn(sprint.name)}`,
  };
}

/**
 * Format a generic/unrecognized event for Slack.
 * Extracts useful details from common Jira webhook payload structures.
 */
export function formatGenericEventForSlack(
  eventType: string,
  payload: Record<string, unknown>,
  siteUrl: string
): SlackMessage {
  // Common payload fields across different event types
  const issue = payload.issue as
    | {
        key?: string;
        fields?: {
          summary?: string;
          project?: { key?: string; name?: string };
          issuetype?: { name?: string };
          priority?: { name?: string };
          status?: { name?: string };
          assignee?: { displayName?: string };
        };
      }
    | undefined;
  const user = payload.user as { displayName?: string } | undefined;
  const issueLink = payload.issueLink as
    | {
        id?: number;
        sourceIssueId?: number;
        destinationIssueId?: number;
        issueLinkType?: { name?: string; outwardName?: string; inwardName?: string };
      }
    | undefined;
  const changelog = payload.changelog as
    | { items?: Array<{ field?: string; fromString?: string; toString?: string }> }
    | undefined;
  const project = (payload.project ?? issue?.fields?.project) as { key?: string; name?: string } | undefined;
  const version = payload.version as { name?: string; description?: string; released?: boolean } | undefined;
  const worklog = payload.worklog as { author?: { displayName?: string }; timeSpent?: string } | undefined;
  const board = payload.board as { id?: number; name?: string } | undefined;

  // Make the event type human-readable (e.g., "issuelink_created" -> "Issue Link Created")
  const readableEvent = eventType
    .replace(/^jira:/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:bell: ${readableEvent}`,
        emoji: true,
      },
    },
  ];

  const details: string[] = [];

  // Issue details
  if (issue?.key) {
    const issueUrl = `${siteUrl}/browse/${issue.key}`;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${issueUrl}|${escapeSlackMrkdwn(issue.key)}>* ${escapeSlackMrkdwn(issue.fields?.summary || '')}`,
      },
    });

    // Issue metadata
    const meta: string[] = [];
    if (issue.fields?.status?.name) meta.push(`*Status:* ${escapeSlackMrkdwn(issue.fields.status.name)}`);
    if (issue.fields?.issuetype?.name) meta.push(`*Type:* ${escapeSlackMrkdwn(issue.fields.issuetype.name)}`);
    if (issue.fields?.priority?.name) {
      const emoji = getPriorityEmoji(issue.fields.priority.name);
      meta.push(`${emoji} *Priority:* ${escapeSlackMrkdwn(issue.fields.priority.name)}`);
    }
    if (issue.fields?.assignee?.displayName)
      meta.push(`*Assignee:* ${escapeSlackMrkdwn(issue.fields.assignee.displayName)}`);
    if (meta.length > 0) details.push(meta.join('  |  '));
  }

  // Issue link details
  if (issueLink?.issueLinkType) {
    const linkType = issueLink.issueLinkType;
    const linkDesc = escapeSlackMrkdwn(linkType.outwardName || linkType.name || 'linked');
    details.push(`*Link type:* ${linkDesc}`);
    if (issueLink.sourceIssueId) details.push(`*Source issue ID:* ${issueLink.sourceIssueId}`);
    if (issueLink.destinationIssueId) details.push(`*Destination issue ID:* ${issueLink.destinationIssueId}`);
  }

  // Version/release details
  if (version?.name) {
    const versionParts = [`*Version:* ${escapeSlackMrkdwn(version.name)}`];
    if (version.description) versionParts.push(escapeSlackMrkdwn(version.description));
    if (version.released !== undefined)
      versionParts.push(version.released ? ':white_check_mark: Released' : 'Unreleased');
    details.push(versionParts.join('  |  '));
  }

  // Worklog details
  if (worklog) {
    const wlParts: string[] = [];
    if (worklog.author?.displayName) wlParts.push(`*By:* ${escapeSlackMrkdwn(worklog.author.displayName)}`);
    if (worklog.timeSpent) wlParts.push(`*Time:* ${escapeSlackMrkdwn(worklog.timeSpent)}`);
    if (wlParts.length > 0) details.push(wlParts.join('  |  '));
  }

  // Board details
  if (board?.name) {
    details.push(`*Board:* ${escapeSlackMrkdwn(board.name)}`);
  }

  // Changelog
  if (changelog?.items && changelog.items.length > 0) {
    const changes = changelog.items
      .slice(0, 3)
      .map(
        item =>
          `• ${escapeSlackMrkdwn(item.field || '')}: ${escapeSlackMrkdwn(item.fromString || 'None')} → ${escapeSlackMrkdwn(item.toString || 'None')}`
      );
    if (changelog.items.length > 3) {
      changes.push(`_...and ${changelog.items.length - 3} more_`);
    }
    details.push(`*Changes:*\n${changes.join('\n')}`);
  }

  // Add details section
  if (details.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: details.join('\n'),
      },
    });
  }

  // Context line: user + project
  const contextParts: string[] = [];
  if (user?.displayName) contextParts.push(escapeSlackMrkdwn(user.displayName));
  if (project?.name)
    contextParts.push(`${escapeSlackMrkdwn(project.name)}${project.key ? ` (${escapeSlackMrkdwn(project.key)})` : ''}`);
  if (contextParts.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextParts.join(' • ') }],
    });
  }

  // View in Jira button if we have an issue
  if (issue?.key) {
    const issueUrl = `${siteUrl}/browse/${issue.key}`;
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in Jira', emoji: true },
          url: issueUrl,
          style: 'primary',
        },
      ],
    });
  }

  const summary = issue?.key
    ? `${escapeSlackMrkdwn(issue.key)}: ${escapeSlackMrkdwn(issue.fields?.summary || readableEvent)}`
    : readableEvent;

  return {
    blocks,
    text: `:bell: ${summary}`,
  };
}
