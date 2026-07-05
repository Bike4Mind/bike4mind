/**
 * Notion MCP Server - Test Utilities
 *
 * Shared types and utilities for testing MCP tools.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vi } from 'vitest';

/**
 * MCP tool handler response type
 */
export interface McpToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * MCP tool handler function type
 */
export type McpToolHandler = (params: Record<string, unknown>) => Promise<McpToolResponse>;

/**
 * Registered tool entry with handler
 */
export interface RegisteredTool {
  handler: McpToolHandler;
}

/**
 * Creates a mock MCP server that captures registered tools
 */
export function createMockServer(): {
  server: McpServer;
  registeredTools: Map<string, RegisteredTool>;
} {
  const registeredTools = new Map<string, RegisteredTool>();

  const server = {
    tool: vi.fn((name: string, ...args: unknown[]) => {
      const handler = args[args.length - 1] as McpToolHandler;
      registeredTools.set(name, { handler });
    }),
  } as unknown as McpServer;

  return { server, registeredTools };
}

/**
 * Helper to get a registered tool by name
 */
export function getTool(registeredTools: Map<string, RegisteredTool>, toolName: string): RegisteredTool | undefined {
  return registeredTools.get(toolName);
}

/**
 * Parse JSON response from tool handler
 */
export function parseResponse<T = Record<string, unknown>>(result: McpToolResponse): T {
  return JSON.parse(result.content[0].text) as T;
}
