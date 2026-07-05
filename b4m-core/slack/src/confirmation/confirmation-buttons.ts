import * as cheerio from 'cheerio';
import {
  TOOL_CREATE_ISSUE,
  TOOL_UPDATE_ISSUE,
  TOOL_ADD_ISSUE_TO_PROJECT,
  TOOL_UPDATE_PROJECT_ITEM_FIELDS,
} from '@bike4mind/mcp/github/constants';
import {
  JIRA_CREATE_ISSUE,
  JIRA_UPDATE_ISSUE,
  JIRA_UPDATE_ISSUE_TRANSITION,
  JIRA_ASSIGN_ISSUE,
  JIRA_DELETE_ISSUE,
  JIRA_UPLOAD_ATTACHMENT,
  JIRA_DELETE_ATTACHMENT,
  CONFLUENCE_CREATE_PAGE,
  CONFLUENCE_UPDATE_PAGE,
  CONFLUENCE_DELETE_PAGE,
  CONFLUENCE_ADD_PAGE_RESTRICTION,
  CONFLUENCE_REMOVE_PAGE_RESTRICTION,
  CONFLUENCE_UPLOAD_ATTACHMENT,
  CONFLUENCE_DELETE_ATTACHMENT,
} from '@bike4mind/mcp/atlassian/constants';
import { RestrictionPreviewItem } from '@bike4mind/common';

/**
 * Slack preview truncation limits. Section blocks have a 3000 char limit, so
 * truncate to leave room for formatting.
 */
const SLACK_PREVIEW_CREATE_MAX_LENGTH = 1500; // For create operations (more room for content)
const SLACK_PREVIEW_UPDATE_MAX_LENGTH = 1000; // For update operations (less content, more metadata)
const SLACK_PREVIEW_CONFLUENCE_MAX_LENGTH = 2000; // Increased for markdown tables (was 500 for HTML)

// Helper functions

/**
 * Build a standard preview message with consistent formatting.
 * @param emoji - Emoji to display
 * @param title - Preview title (e.g. 'Jira Attachment Upload')
 * @param fields - Array of { label, value } objects
 * @param confirmText - Action text for confirmation (e.g. 'upload this attachment')
 * @param warningText - Optional warning message
 */
function buildPreviewMessage(
  emoji: string,
  title: string,
  fields: Array<{ label: string; value: string | number | undefined }>,
  confirmText: string,
  warningText?: string
): string {
  const lines = [`${emoji} *Preview: ${title}*`, ''];

  for (const field of fields) {
    if (field.value !== undefined && field.value !== '') {
      lines.push(`> *${field.label}:* ${field.value}`);
    }
  }

  if (warningText) {
    lines.push('>', `> *Warning:* ${warningText}`);
  }

  lines.push('', `Click ✅ Confirm to ${confirmText}, or ❌ Cancel to abort.`);

  return lines.join('\n');
}

/**
 * Format attachment upload preview (DRY for both Jira and Confluence)
 */
function formatAttachmentUploadPreview(params: Record<string, unknown>, target: 'jira' | 'confluence'): string {
  const filename = String(params.filename || params.display_filename || 'Unknown file');

  if (target === 'jira') {
    const issueKey = String(params.issueKey || params.display_issue_key || 'Unknown');
    return buildPreviewMessage(
      '📎',
      'Jira Attachment Upload',
      [
        { label: 'Issue', value: issueKey },
        { label: 'File', value: filename },
      ],
      'upload this attachment'
    );
  } else {
    const pageId = String(params.pageId || params.display_page_id || '');
    const pageTitle = String(params.display_page_title || pageId || 'Unknown');
    const comment = params.comment || params.display_comment;
    return buildPreviewMessage(
      '📎',
      'Confluence Attachment Upload',
      [
        { label: 'Page', value: pageTitle },
        { label: 'File', value: filename },
        { label: 'Comment', value: comment ? String(comment) : undefined },
      ],
      'upload this attachment'
    );
  }
}

/**
 * Format attachment deletion preview (DRY for both Jira and Confluence)
 */
function formatAttachmentDeletePreview(params: Record<string, unknown>, target: 'jira' | 'confluence'): string {
  // Prefer display names over IDs for better UX
  const filename = String(params.display_filename || params.filename || params.attachmentId || 'Unknown');
  const targetLabel = target === 'jira' ? 'Jira' : 'Confluence';

  return buildPreviewMessage(
    '⚠️',
    `${targetLabel} Attachment Deletion`,
    [{ label: 'File', value: filename }],
    'DELETE this attachment',
    'This action cannot be undone!'
  );
}

/**
 * Helper to format Confluence page restriction preview
 * Supports both single and bulk restrictions (DRY principle)
 */
function formatConfluenceRestrictionPreview(params: Record<string, unknown>, action: 'add' | 'remove'): string {
  const pageTitle = params.display_page_title || params.pageId;
  const spaceName = params.display_space_name;
  const isAdd = action === 'add';
  const emoji = isAdd ? '🔒' : '🔓';
  const actionText = isAdd ? 'Add' : 'Remove';
  const noteText = isAdd
    ? 'Adding any restriction makes the page explicitly restricted (no longer inherits from parent).'
    : 'If all restrictions are removed, the page will inherit permissions from its parent.';

  // Check if this is a bulk operation (has restrictions array)
  const restrictions = params.restrictions as RestrictionPreviewItem[] | undefined;
  const isBulk = restrictions && Array.isArray(restrictions) && restrictions.length > 0;

  if (isBulk) {
    // Bulk operation preview
    const confirmText = isAdd
      ? `add these ${restrictions.length} restrictions`
      : `remove these ${restrictions.length} restrictions`;

    const lines = [
      `${emoji} *Preview: ${actionText} ${restrictions.length} Confluence Page Restrictions*`,
      '',
      `> *Page:* ${pageTitle}`,
    ];

    if (spaceName) {
      lines.push(`> *Space:* ${spaceName}`);
    }

    lines.push('>', '> *Restrictions:*');

    // Group restrictions by access type for cleaner display
    const editRestrictions = restrictions.filter(r => r.operation === 'update');
    const viewRestrictions = restrictions.filter(r => r.operation === 'read');

    if (editRestrictions.length > 0) {
      lines.push(`> • *Edit access:* ${editRestrictions.map(r => r.display_subject_name || r.subject).join(', ')}`);
    }
    if (viewRestrictions.length > 0) {
      lines.push(`> • *View access:* ${viewRestrictions.map(r => r.display_subject_name || r.subject).join(', ')}`);
    }

    lines.push('>', `> *Note:* ${noteText}`, '', `Click ✅ Confirm to ${confirmText}, or ❌ Cancel to abort.`);

    return lines.join('\n');
  } else {
    // Single restriction preview (backward compatible)
    const operationDisplay = params.operation === 'read' ? 'View' : 'Edit';
    const restrictionTypeDisplay = params.restrictionType === 'user' ? 'User' : 'Group';
    const subjectName = params.display_subject_name || params.subject;
    const confirmText = isAdd ? 'add this restriction' : 'remove this restriction';

    const lines = [`${emoji} *Preview: ${actionText} Confluence Page Restriction*`, '', `> *Page:* ${pageTitle}`];

    if (spaceName) {
      lines.push(`> *Space:* ${spaceName}`);
    }

    lines.push(
      `> *Restriction Type:* ${operationDisplay} access`,
      `> *${restrictionTypeDisplay}:* ${subjectName}`,
      '>',
      `> *Note:* ${noteText}`,
      '',
      `Click ✅ Confirm to ${confirmText}, or ❌ Cancel to abort.`
    );

    return lines.join('\n');
  }
}

/**
 * Convert HTML table to Markdown table
 * Handles Confluence storage format (XHTML tables)
 * Uses cheerio for robust HTML parsing
 */
function htmlTableToMarkdown(html: string): string {
  if (!html.includes('<table')) {
    return html;
  }

  try {
    const $ = cheerio.load(html);
    const rows: string[][] = [];

    // Extract all rows (both thead and tbody)
    $('tr').each((_, rowEl) => {
      const cells: string[] = [];

      // Extract cells (th or td)
      $(rowEl)
        .find('th, td')
        .each((_, cellEl) => {
          // Get text content, normalize whitespace, escape pipes
          const cellContent = $(cellEl).text().replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
          cells.push(cellContent || ' ');
        });

      if (cells.length > 0) {
        rows.push(cells);
      }
    });

    if (rows.length === 0) {
      return html; // No table data found, return original
    }

    // Build markdown table
    const mdLines: string[] = [];

    // Header row
    mdLines.push('| ' + rows[0].join(' | ') + ' |');

    // Separator row
    mdLines.push('| ' + rows[0].map(() => '---').join(' | ') + ' |');

    // Data rows
    for (let i = 1; i < rows.length; i++) {
      mdLines.push('| ' + rows[i].join(' | ') + ' |');
    }

    return mdLines.join('\n');
  } catch {
    // If parsing fails, return original content
    return html;
  }
}

/**
 * Slack Block Kit types for confirmation buttons
 */
export interface SlackBlockKitButton {
  type: 'button';
  text: {
    type: 'plain_text';
    text: string;
    emoji: boolean;
  };
  style?: 'primary' | 'danger';
  action_id: string;
  value: string;
  confirm?: {
    title: { type: 'plain_text'; text: string };
    text: { type: 'plain_text' | 'mrkdwn'; text: string };
    confirm: { type: 'plain_text'; text: string };
    deny: { type: 'plain_text'; text: string };
    style?: 'primary' | 'danger';
  };
}

export interface SlackBlockKitActions {
  type: 'actions';
  elements: SlackBlockKitButton[];
}

export interface SlackBlockKitDivider {
  type: 'divider';
}

export interface SlackBlockKitOverflowOption {
  text: { type: 'plain_text'; text: string; emoji?: boolean };
  value: string;
}

export interface SlackBlockKitSection {
  type: 'section';
  text: {
    type: 'mrkdwn' | 'plain_text';
    text: string;
  };
  accessory?:
    | {
        type: 'button';
        text: {
          type: 'plain_text';
          text: string;
          emoji?: boolean;
        };
        action_id: string;
        value: string;
      }
    | {
        type: 'overflow';
        action_id: string;
        options: SlackBlockKitOverflowOption[];
      };
}

export interface SlackBlockKitContext {
  type: 'context';
  elements: Array<{
    type: 'mrkdwn' | 'plain_text' | 'image';
    text?: string;
    image_url?: string;
    alt_text?: string;
  }>;
}

export type SlackBlockKitElement =
  | SlackBlockKitActions
  | SlackBlockKitDivider
  | SlackBlockKitSection
  | SlackBlockKitContext;

/**
 * Format a preview message from pendingAction params, for consistent and complete
 * previews regardless of AI behavior.
 *
 * @param tool - The MCP tool name (e.g. "create_issue", "jira_create_issue")
 * @param params - The tool parameters
 * @returns Formatted preview string for Slack
 */
export function formatPreviewFromParams(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case TOOL_CREATE_ISSUE: {
      // GitHub issue - repo name prominently at top
      const repoDisplay = `${params.owner}/${params.repo}`;
      const assignees =
        Array.isArray(params.assignees) && params.assignees.length > 0
          ? params.assignees.map(a => `@${a}`).join(', ')
          : 'None';
      // Truncate body to avoid Slack's 3000 char limit for section blocks
      const fullBody = String(params.body || '');
      const bodyPreview = fullBody.substring(0, SLACK_PREVIEW_CREATE_MAX_LENGTH);
      const bodyLines = bodyPreview
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      const truncated =
        fullBody.length > SLACK_PREVIEW_CREATE_MAX_LENGTH ? '\n> _... (content truncated for preview)_' : '';
      return [
        `📋 *GitHub Issue* — \`${repoDisplay}\``,
        '',
        `> *Title:* ${params.title}`,
        '> *Description:*',
        bodyLines + truncated,
        `> *Assignees:* ${assignees}`,
        '',
        'Click ✅ Confirm to create this issue, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case TOOL_UPDATE_ISSUE: {
      // GitHub issue update
      const updates: string[] = [];
      if (params.title) updates.push(`> *Title:* ${params.title}`);
      if (params.body) {
        // Truncate body to avoid Slack's 3000 char limit
        const fullBody = String(params.body);
        const bodyPreview = fullBody.substring(0, SLACK_PREVIEW_UPDATE_MAX_LENGTH);
        const truncated = fullBody.length > SLACK_PREVIEW_UPDATE_MAX_LENGTH ? '... _(truncated)_' : '';
        updates.push(`> *Body:* ${bodyPreview}${truncated}`);
      }
      if (params.state) updates.push(`> *State:* ${params.state}`);
      if (params.type) updates.push(`> *Type:* ${params.type}`);
      if (Array.isArray(params.assignees)) updates.push(`> *Assignees:* ${params.assignees.join(', ') || 'None'}`);
      if (Array.isArray(params.labels)) updates.push(`> *Labels:* ${params.labels.join(', ') || 'None'}`);

      return [
        '📋 *Preview: GitHub Issue Update*',
        '',
        `> *Repository:* ${params.owner}/${params.repo}`,
        `> *Issue:* #${params.issue_number}`,
        '> *Changes:*',
        ...updates,
        '',
        'Click ✅ Confirm to update this issue, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case JIRA_CREATE_ISSUE: {
      // Jira ticket
      const assignee = params.assigneeAccountId ? String(params.assigneeAccountId) : 'Unassigned';
      const labels = Array.isArray(params.labels) && params.labels.length > 0 ? params.labels.join(', ') : 'None';
      // Truncate description to avoid Slack's 3000 char limit
      const fullDesc = String(params.description || '');
      const descPreview = fullDesc.substring(0, SLACK_PREVIEW_CREATE_MAX_LENGTH);
      const descLines = descPreview
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      const truncated =
        fullDesc.length > SLACK_PREVIEW_CREATE_MAX_LENGTH ? '\n> _... (content truncated for preview)_' : '';
      return [
        '📋 *Preview: Jira Ticket*',
        '',
        `> *Project:* ${params.projectKey}`,
        `> *Type:* ${params.issueTypeName || 'Task'}`,
        `> *Title:* ${params.summary}`,
        '> *Description:*',
        descLines + truncated,
        `> *Assignee:* ${assignee}`,
        `> *Labels:* ${labels}`,
        '',
        'Click ✅ Confirm to create this ticket, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case JIRA_UPDATE_ISSUE:
    case JIRA_UPDATE_ISSUE_TRANSITION: {
      // Jira issue update
      const updates: string[] = [];
      if (params.summary) updates.push(`> *Summary:* ${params.summary}`);
      if (params.description) {
        // Truncate description to avoid Slack's 3000 char limit
        const fullDesc = String(params.description);
        const descPreview = fullDesc.substring(0, SLACK_PREVIEW_UPDATE_MAX_LENGTH);
        const truncated = fullDesc.length > SLACK_PREVIEW_UPDATE_MAX_LENGTH ? '... _(truncated)_' : '';
        updates.push(`> *Description:* ${descPreview}${truncated}`);
      }
      if (params.transitionName) updates.push(`> *Transition to:* ${params.transitionName}`);
      if (params.assigneeAccountId) updates.push(`> *Assignee:* ${params.assigneeAccountId}`);

      return [
        '📋 *Preview: Jira Issue Update*',
        '',
        `> *Issue:* ${params.issueKey}`,
        '> *Changes:*',
        ...updates,
        '',
        'Click ✅ Confirm to update this issue, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case JIRA_ASSIGN_ISSUE: {
      return [
        '📋 *Preview: Jira Issue Assignment*',
        '',
        `> *Issue:* ${params.issueKey}`,
        `> *Assign to:* ${params.assigneeAccountId || 'Unassigned'}`,
        '',
        'Click ✅ Confirm to assign this issue, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case JIRA_DELETE_ISSUE: {
      return [
        '⚠️ *Preview: Jira Issue Deletion*',
        '',
        `> *Issue:* ${params.issueKey}`,
        '>',
        '> *Warning:* This action cannot be undone!',
        '',
        'Click ✅ Confirm to DELETE this issue, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case CONFLUENCE_CREATE_PAGE: {
      // Handle both spaceId and spaceKey (AI may use either)
      const space = params.spaceId || params.spaceKey || 'Unknown';
      const fullContent = String(params.content || '');
      // Convert HTML tables to markdown for better display
      const markdownContent = htmlTableToMarkdown(fullContent);
      const contentPreview = markdownContent.substring(0, SLACK_PREVIEW_CONFLUENCE_MAX_LENGTH);
      const contentLines = contentPreview
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      const truncated = markdownContent.length > SLACK_PREVIEW_CONFLUENCE_MAX_LENGTH ? '\n> _... (truncated)_' : '';
      return [
        '📋 *Preview: Confluence Page*',
        '',
        `> *Space:* ${space}`,
        `> *Title:* ${params.title}`,
        '> *Content:*',
        contentLines + truncated,
        '',
        'Click ✅ Confirm to create this page, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case CONFLUENCE_UPDATE_PAGE: {
      const fullContent = String(params.content || '');
      // Convert HTML tables to markdown for better display
      const markdownContent = htmlTableToMarkdown(fullContent);
      const contentPreview = markdownContent.substring(0, SLACK_PREVIEW_CONFLUENCE_MAX_LENGTH);
      const contentLines = contentPreview
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      const truncated = markdownContent.length > SLACK_PREVIEW_CONFLUENCE_MAX_LENGTH ? '\n> _... (truncated)_' : '';
      const title = params.newTitle || params.currentTitle;

      return [
        '📋 *Preview: Confluence Page Update*',
        '',
        `> *Page ID:* ${params.pageId}`,
        `> *Title:* ${title}`,
        '> *Content:*',
        contentLines + truncated,
        '',
        'Click ✅ Confirm to update this page, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case CONFLUENCE_DELETE_PAGE: {
      return [
        '⚠️ *Preview: Confluence Page Deletion*',
        '',
        `> *Page ID:* ${params.pageId}`,
        '>',
        '> *Warning:* This action cannot be undone!',
        '',
        'Click ✅ Confirm to DELETE this page, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case CONFLUENCE_ADD_PAGE_RESTRICTION:
      return formatConfluenceRestrictionPreview(params, 'add');

    case CONFLUENCE_REMOVE_PAGE_RESTRICTION:
      return formatConfluenceRestrictionPreview(params, 'remove');

    // Attachment operations (Jira & Confluence)

    case JIRA_UPLOAD_ATTACHMENT:
      return formatAttachmentUploadPreview(params, 'jira');

    case JIRA_DELETE_ATTACHMENT:
      return formatAttachmentDeletePreview(params, 'jira');

    case CONFLUENCE_UPLOAD_ATTACHMENT:
      return formatAttachmentUploadPreview(params, 'confluence');

    case CONFLUENCE_DELETE_ATTACHMENT:
      return formatAttachmentDeletePreview(params, 'confluence');

    case TOOL_ADD_ISSUE_TO_PROJECT: {
      const projectName = params.display_project_name || 'GitHub Project';
      const issueTitle = params.display_issue_title || 'Issue';
      const repository = params.display_repository;

      const lines = [
        '📋 *Preview: Add Issue to GitHub Project*',
        '',
        `> *Target Project:* ${projectName}`,
        `> *Issue:* ${issueTitle}`,
      ];

      if (repository) {
        lines.push(`> *Repository:* ${repository}`);
      }

      lines.push(
        '>',
        '> *Note:* This issue will be added to the project board. You can then update its fields (Priority, Status, etc.).',
        '',
        'Click ✅ Confirm to add this issue to the project, or ❌ Cancel to abort.'
      );

      return lines.join('\n');
    }

    case TOOL_UPDATE_PROJECT_ITEM_FIELDS: {
      // Handle both single and batch field updates
      const projectName = params.display_project_name || 'GitHub Project';
      const issueTitle = params.display_issue_title || 'Issue';
      const updates = Array.isArray(params.updates) ? params.updates : [];

      if (updates.length === 0 && params.field_name) {
        // Single field update (old API)
        const fieldName = String(params.field_name || 'field');
        const newValue = String(params.new_value || params.display_new_value || 'value');
        const currentValue = String(params.current_value || params.display_current_value || '');

        return [
          '📋 *Preview: Update GitHub Project Field*',
          '',
          `> *Project:* ${projectName}`,
          `> *Issue:* ${issueTitle}`,
          '>',
          `> *${fieldName}:* ${currentValue ? `${currentValue} → ${newValue}` : `→ ${newValue}`}`,
          '',
          'Click ✅ Confirm to update this field, or ❌ Cancel to abort.',
        ].join('\n');
      }

      // Batch updates
      const fieldLines = updates.map((update: any) => {
        const fieldName = update.field_name || 'Field';
        const newValue = update.new_value || String(update.value);
        const currentValue = update.current_value;
        return `> *${fieldName}:* ${currentValue ? `${currentValue} → ${newValue}` : `→ ${newValue}`}`;
      });

      return [
        '📋 *Preview: Update GitHub Project Fields*',
        '',
        `> *Project:* ${projectName}`,
        `> *Issue:* ${issueTitle}`,
        '>',
        `> *Updates (${updates.length} fields):*`,
        ...fieldLines,
        '',
        'Click ✅ Confirm to update these fields, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case 'create_milestone': {
      // GitHub milestone creation
      const dueDate = params.due_on ? new Date(String(params.due_on)).toLocaleDateString() : 'No due date';
      const fullDesc = String(params.description || '');
      const descPreview = fullDesc.substring(0, SLACK_PREVIEW_CREATE_MAX_LENGTH);
      const descLines = descPreview
        ? descPreview
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n')
        : '> _No description_';
      const truncated =
        fullDesc.length > SLACK_PREVIEW_CREATE_MAX_LENGTH ? '\n> _... (content truncated for preview)_' : '';

      return [
        '🎯 *Preview: GitHub Milestone*',
        '',
        `> *Repository:* ${params.owner}/${params.repo}`,
        `> *Title:* ${params.title}`,
        `> *Due Date:* ${dueDate}`,
        `> *State:* ${params.state || 'open'}`,
        '> *Description:*',
        descLines + truncated,
        '',
        'Click ✅ Confirm to create this milestone, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case 'update_milestone': {
      // GitHub milestone update
      const updates: string[] = [];
      if (params.title) updates.push(`> *Title:* ${params.title}`);
      if (params.description) {
        const fullDesc = String(params.description);
        const descPreview = fullDesc.substring(0, SLACK_PREVIEW_UPDATE_MAX_LENGTH);
        const truncated = fullDesc.length > SLACK_PREVIEW_UPDATE_MAX_LENGTH ? '... _(truncated)_' : '';
        updates.push(`> *Description:* ${descPreview}${truncated}`);
      }
      if (params.due_on) {
        const dueDate = new Date(String(params.due_on)).toLocaleDateString();
        updates.push(`> *Due Date:* ${dueDate}`);
      }
      if (params.state) updates.push(`> *State:* ${params.state}`);

      return [
        '🎯 *Preview: GitHub Milestone Update*',
        '',
        `> *Repository:* ${params.owner}/${params.repo}`,
        `> *Milestone:* #${params.milestone_number}`,
        '> *Changes:*',
        ...(updates.length > 0 ? updates : ['> _No changes specified_']),
        '',
        'Click ✅ Confirm to update this milestone, or ❌ Cancel to abort.',
      ].join('\n');
    }

    case 'close_milestone': {
      // GitHub milestone close
      const milestoneTitle = params.title || `Milestone #${params.milestone_number}`;

      return [
        '🎯 *Preview: Close GitHub Milestone*',
        '',
        `> *Repository:* ${params.owner}/${params.repo}`,
        `> *Milestone:* ${milestoneTitle}`,
        '>',
        '> This will mark the milestone as *closed*.',
        '',
        'Click ✅ Confirm to close this milestone, or ❌ Cancel to abort.',
      ].join('\n');
    }

    default: {
      // Fallback for unknown tools - show raw params
      const paramsLines = JSON.stringify(params, null, 2)
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      return [
        `📋 *Preview: ${tool}*`,
        '',
        '> *Parameters:*',
        paramsLines,
        '',
        'Click ✅ Confirm to proceed, or ❌ Cancel to abort.',
      ].join('\n');
    }
  }
}

/**
 * Build Block Kit confirm/cancel buttons for a preview message.
 * @param questId - Quest ID containing the pendingAction to confirm
 * @returns divider + action buttons
 */
export function buildConfirmationButtons(questId: string): SlackBlockKitElement[] {
  return [
    {
      type: 'divider',
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✅ Confirm',
            emoji: true,
          },
          style: 'primary',
          action_id: 'confirm_action',
          value: questId,
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '❌ Cancel',
            emoji: true,
          },
          style: 'danger',
          action_id: 'cancel_action',
          value: questId,
        },
      ],
    },
  ];
}

// Attachment download buttons

/**
 * Attachment info for download buttons
 */
export interface AttachmentDownloadInfo {
  source: 'jira' | 'confluence';
  attachmentId: string;
  filename: string;
  emoji: string;
  sizeFormatted: string;
  /** Who uploaded the attachment */
  author?: string;
  /** When the attachment was created (ISO 8601) */
  created?: string;
  /** For Jira attachments */
  issueKey?: string;
  /** For Confluence attachments */
  pageId?: string;
}

/**
 * Build download buttons for a list of attachments.
 * Uses section blocks with accessory buttons for a cleaner (poll-style) layout.
 *
 * @param attachments - Array of attachment info
 * @param questId - Quest ID referenced by the download/delete actions
 * @returns Slack Block Kit elements with download buttons
 */
export function buildAttachmentDownloadButtons(
  attachments: AttachmentDownloadInfo[],
  questId: string
): SlackBlockKitElement[] {
  if (attachments.length === 0) {
    return [];
  }

  // Limit number of attachments to display
  const MAX_ATTACHMENTS = 15;
  const displayAttachments = attachments.slice(0, MAX_ATTACHMENTS);
  const hasMore = attachments.length > MAX_ATTACHMENTS;

  const elements: SlackBlockKitElement[] = [];

  // Create a section with accessory button for each attachment
  for (let i = 0; i < displayAttachments.length; i++) {
    const att = displayAttachments[i];
    // Build the description line: size + author + date
    const parts = [att.sizeFormatted];
    if (att.author) parts.push(`by ${att.author}`);
    if (att.created) {
      const date = new Date(att.created);
      if (!isNaN(date.getTime())) {
        parts.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
      }
    }
    const description = parts.join(' • ');
    // Use compact questId:index reference (Slack overflow values limited to 75 chars)
    const ref = `${questId}:${i}`;

    elements.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${att.emoji} *${att.filename}*\n${description}`,
      },
      accessory: {
        type: 'overflow',
        action_id: `attachment_menu_${att.attachmentId}`,
        options: [
          {
            text: { type: 'plain_text', text: 'Download', emoji: true },
            value: `download:${ref}`,
          },
          {
            text: { type: 'plain_text', text: 'Delete', emoji: true },
            value: `delete:${ref}`,
          },
        ],
      },
    });
  }

  if (hasMore) {
    elements.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_...and ${attachments.length - MAX_ATTACHMENTS} more attachments_`,
        },
      ],
    });
  }

  return elements;
}
