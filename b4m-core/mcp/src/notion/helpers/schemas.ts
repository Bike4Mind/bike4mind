/**
 * Notion MCP Server - Reusable Zod Schemas
 *
 * Common schema definitions for input validation across tools.
 */

import { z } from 'zod';

/**
 * Notion UUID format: 8-4-4-4-12 hex characters, with or without dashes.
 * Notion accepts both formats (e.g., "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 * or "a1b2c3d4e5f67890abcdef1234567890").
 */
const NOTION_UUID_REGEX = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * Schema for a Notion page ID (UUID format).
 */
export const notionPageIdSchema = z
  .string()
  .regex(NOTION_UUID_REGEX, 'Invalid Notion page ID format. Must be a UUID (with or without dashes).')
  .describe('Notion page ID (UUID format)');

/**
 * Schema for a Notion database ID (UUID format).
 */
export const notionDatabaseIdSchema = z
  .string()
  .regex(NOTION_UUID_REGEX, 'Invalid Notion database ID format. Must be a UUID (with or without dashes).')
  .describe('Notion database ID (UUID format)');

/**
 * Search filter type.
 */
export const searchFilterTypeSchema = z
  .enum(['page', 'database'])
  .describe('Result type filter. Use "page" for regular pages or "database" for databases.');

/**
 * Pagination parameters for search.
 */
export const paginationParams = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of results to return (1-100, default 10)'),
};

/**
 * Cursor for paginated list endpoints.
 */
export const startCursorSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Pagination cursor from a previous Notion response');
