/**
 * GitHub MCP Server - Shared TypeScript Types
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Re-export McpServer type for tool registration functions
export type { McpServer };

// Standard MCP response content - using index signature for SDK compatibility
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

// Error type for GitHub API errors
export interface GitHubApiError {
  message: string;
  status?: number;
  response?: {
    data?: unknown;
  };
}

// Repository info returned by helper functions
export interface RepositoryInfo {
  owner: string;
  repo: string;
  fullName: string;
}
