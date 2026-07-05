/**
 * GitHub MCP Server - Reusable Zod Schemas
 *
 * Common schema definitions to eliminate repetition across tools.
 */

import { z } from 'zod';

// Repository owner schema - used in ~10 tools
export const ownerSchema = z
  .string()
  .min(1, 'Owner is required')
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/, 'Invalid owner format')
  .describe('Repository owner (username or organization)');

// Repository name schema - used in ~10 tools
export const repoSchema = z
  .string()
  .min(1, 'Repository name is required')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Invalid repository name format')
  .describe('Repository name');

// Organization name schema
export const orgSchema = z
  .string()
  .min(1, 'Organization name is required')
  .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/, 'Invalid organization name format')
  .describe('Organization name');

// Issue number schema
export const issueNumberSchema = z.number().min(1, 'Issue number is required').describe('Issue number');

// Milestone number schema
export const milestoneNumberSchema = z.number().min(1, 'Milestone number is required').describe('Milestone number');

// Confirmation parameters - re-exported from shared location
export { confirmationParams } from '../../shared/schemas.js';

// Pagination parameters
export const paginationParams = {
  per_page: z.number().optional().describe('Results per page (max 100, default 30)'),
  page: z.number().optional().describe('Page number for pagination'),
};

// Issue state filter
export const issueStateSchema = z
  .enum(['open', 'closed', 'all'])
  .optional()
  .describe('Issue state filter (default: open)');

// PR state filter
export const prStateSchema = z.enum(['open', 'closed', 'all']).optional().describe('PR state filter (default: open)');

// Project ID schema (must start with PVT_)
export const projectIdSchema = z
  .string()
  .regex(
    /^PVT_/,
    'Project ID must start with "PVT_". If you have a project name, first call list_org_projects to get the ID.'
  )
  .describe(
    'Project ID starting with "PVT_" (from list_org_projects). If user provides a name like "Project 1", first call list_org_projects to get the ID.'
  );

// Issue node ID schema (must start with I_)
export const issueNodeIdSchema = z
  .string()
  .regex(/^I_/, 'Issue node ID must start with "I_". Use get_issue to fetch the node_id from an issue number.')
  .describe('Issue node ID (GraphQL ID). Use get_issue to fetch the node_id from an issue number.');

// Project item ID schema (must start with PVTI_)
export const projectItemIdSchema = z
  .string()
  .regex(/^PVTI_/, 'Project item ID must start with "PVTI_"')
  .describe('Project item ID (from get_project_item)');

// Pull request number schema
export const pullNumberSchema = z.number().min(1, 'Pull request number is required').describe('Pull request number');

// PR Review event type schema
export const reviewEventSchema = z
  .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
  .describe('Review action type: APPROVE, REQUEST_CHANGES, or COMMENT');

// PR Review comment schema for inline comments
export const reviewCommentSchema = z.object({
  path: z.string().min(1, 'File path is required').describe('File path relative to repository root'),
  line: z
    .number()
    .min(1, 'Line number must be positive')
    .describe('Line number in the file (use the new file line number)'),
  side: z
    .enum(['LEFT', 'RIGHT'])
    .prefault('RIGHT')
    .describe('LEFT for deletions (old file), RIGHT for additions/context (new file)'),
  body: z
    .string()
    .min(1, 'Comment text is required')
    .max(65536, 'Comment must be 65536 characters or less')
    .describe('Comment text (supports Markdown)'),
  start_line: z.number().min(1).optional().describe('Start line for multi-line comments (optional)'),
  start_side: z.enum(['LEFT', 'RIGHT']).optional().describe('Side for start of multi-line comment (optional)'),
});

// PR Review body schema
export const reviewBodySchema = z
  .string()
  .max(65536, 'Review body must be 65536 characters or less')
  .describe('Review summary comment (supports Markdown)');
