/**
 * Atlassian MCP Server - Reusable Zod Schemas
 *
 * Common schema definitions to eliminate repetition across tools.
 * Uses shared constants from @bike4mind/common.
 */

import { z } from 'zod';
import { RESTRICTION_OPERATIONS, RESTRICTION_SUBJECT_TYPES } from '@bike4mind/common';

// ============================================================================
// Jira Schemas
// ============================================================================

export const issueKeySchema = z.string().describe('The issue key (e.g., PROJ-123).');

export const projectKeySchema = z
  .string()
  .describe(
    'The project key (e.g., PROJ). If unknown, ask the user to provide the project key or project name and then call jira_list_projects with the query parameter to search for the project and get its key.'
  );

export const issueTypeNameSchema = z
  .string()
  .prefault('Task')
  .describe(
    'Issue type name (e.g., Task, Epic, Subtask). Use common names directly or call jira_list_issue_types to discover custom issue types.'
  );

// ============================================================================
// Jira Agile Schemas
// ============================================================================

export const boardIdSchema = z.number().describe('The ID of the board.');

export const sprintIdSchema = z.number().describe('The ID of the sprint.');

// ============================================================================
// Confluence Schemas
// ============================================================================

export const pageIdSchema = z
  .string()
  .describe(
    'The Confluence page ID (numeric). If the user provides a page title instead of ID, first call confluence_search with the title to find the page and get its ID.'
  );

export const commentIdSchema = z.string().describe('The ID of the comment.');

// ============================================================================
// Cross-domain Schemas
// ============================================================================

export const attachmentIdSchema = z.string().describe('The attachment ID.');

export const userIdentifierSchema = z.string().describe("User's Atlassian account ID, email address, or display name.");

// ============================================================================
// Pagination Params (spread into tool schemas)
// ============================================================================

export const paginationParams = {
  startAt: z.number().optional().describe('Starting index for pagination (default 0).'),
  maxResults: z.number().optional().describe('Maximum number of results to return.'),
};

// ============================================================================
// Upload Attachment Params (shared between Jira and Confluence uploads)
// ============================================================================

export const uploadFileParams = {
  filename: z.string().describe('Name for the uploaded file (e.g., "screenshot.png", "report.pdf").'),
  content: z
    .string()
    .optional()
    .describe('Base64-encoded file content (optional if slackFileUrl or fabFileId is provided).'),
  fabFileId: z
    .string()
    .optional()
    .describe(
      'FAB file ID for files already stored in the system (e.g., from Slack uploads). Use this when uploading files shared in Slack.'
    ),
  slackFileUrl: z
    .string()
    .optional()
    .describe('Slack file URL (url_private_download). If provided, file will be downloaded server-side.'),
  slackFileSize: z.number().optional().describe('File size in bytes from Slack metadata.'),
  mimeType: z
    .string()
    .optional()
    .describe('MIME type (e.g., "image/png", "application/pdf"). Auto-detected from filename if omitted.'),
};

// ============================================================================
// Restriction Schemas
// ============================================================================

export const operationSchema = z
  .enum(RESTRICTION_OPERATIONS)
  .describe('Restriction type: "read" for view access, "update" for edit access.');

export const restrictionTypeSchema = z
  .enum(RESTRICTION_SUBJECT_TYPES)
  .describe('Subject type: "user" for individual user, "group" for a group.');

export const subjectSchema = z
  .string()
  .describe(
    'The Atlassian account ID (for user type) or group name (for group type). Account IDs look like "712020:89d4daa3-05d6-413a-82be-4b36a33bafe2". DO NOT pass usernames like "john.doe" - you MUST first call jira_search_users to look up the account ID.'
  );

/**
 * Schema for a single restriction item (used in bulk operations)
 */
export const restrictionItemSchema = z.object({
  operation: z.enum(RESTRICTION_OPERATIONS).describe('"read" for view access, "update" for edit access.'),
  restrictionType: z.enum(RESTRICTION_SUBJECT_TYPES).describe('"user" for individual user, "group" for a group.'),
  subject: z
    .string()
    .describe(
      'The Atlassian account ID (for user) or group name (for group). Account IDs look like "712020:89d4daa3-05d6-413a-82be-4b36a33bafe2".'
    ),
});

/**
 * Schema for bulk restrictions array
 */
export const restrictionsArraySchema = z
  .array(restrictionItemSchema)
  .min(1)
  .describe(
    'Array of restrictions to add/remove. Each item specifies operation (read/update), restrictionType (user/group), and subject (account ID or group name). Use this for bulk operations involving multiple users/groups with different access levels.'
  );

export type RestrictionItem = z.infer<typeof restrictionItemSchema>;

/**
 * Shared schema for page restriction tools (add/remove)
 * Supports both single and bulk operations
 */
export const pageRestrictionParamsSchema = {
  pageId: pageIdSchema,
  // Single restriction params (backward compatible)
  operation: operationSchema
    .optional()
    .describe(
      'For single restriction: "read" for view access, "update" for edit access. Omit if using "restrictions" array.'
    ),
  restrictionType: restrictionTypeSchema
    .optional()
    .describe('For single restriction: "user" or "group". Omit if using "restrictions" array.'),
  subject: subjectSchema
    .optional()
    .describe('For single restriction: account ID or group name. Omit if using "restrictions" array.'),
  // Bulk restrictions param
  restrictions: restrictionsArraySchema
    .optional()
    .describe(
      'For BULK operations: array of restrictions with different access levels. Each item has operation, restrictionType, and subject. Example: [{"operation":"update","restrictionType":"user","subject":"account-id-1"},{"operation":"read","restrictionType":"user","subject":"account-id-2"}]'
    ),
};
