/**
 * Notion MCP Server - Shared TypeScript Types
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Re-export McpServer type for tool registration functions
export type { McpServer };

// Standard MCP response content
export interface McpTextContent {
  [x: string]: unknown;
  type: 'text';
  text: string;
}

export interface McpResponse {
  [x: string]: unknown;
  content: McpTextContent[];
  isError?: boolean;
}

// Error type for Notion API errors
export interface NotionApiError {
  message: string;
  status?: number;
  code?: string;
}

// Notion page parent types
export type NotionPageParent = { page_id: string } | { database_id: string } | { workspace: true };

// Notion search response
export interface NotionSearchResponse {
  results: NotionSearchResult[];
  has_more?: boolean;
  next_cursor?: string | null;
}

// Notion search result (page or database)
export interface NotionSearchResult {
  object: string;
  id: string;
  url?: string;
  parent?: Record<string, unknown>;
  properties?: Record<string, NotionProperty>;
}

// Notion property with title type
export interface NotionProperty {
  type: string;
  title?: NotionRichText[];
}

// Notion rich text element
export interface NotionRichText {
  plain_text?: string;
}

// Notion page creation response
export interface NotionPageResponse {
  id: string;
  url?: string;
  object: string;
}

// Notion page/block retrieve response (for ancestry validation)
export interface NotionRetrieveResponse {
  id: string;
  object: string;
  parent?: {
    type: string;
    page_id?: string;
    database_id?: string;
    workspace?: boolean;
    block_id?: string;
  };
}

// Notion append blocks response
export interface NotionAppendBlocksResponse {
  object: 'list';
  results: Array<{
    id: string;
    type: string;
    object: string;
  }>;
}

export interface NotionBlockChildrenResponse {
  results: NotionBlock[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export interface NotionRichTextWithHref extends NotionRichText {
  href?: string | null;
}

export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  [key: string]: unknown;
}
