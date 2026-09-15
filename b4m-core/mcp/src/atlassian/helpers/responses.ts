/**
 * Atlassian MCP Server - Response Helpers
 *
 * DRY response builders for MCP tool handlers.
 */

import { getErrorMessage } from '@bike4mind/common';

export function createJsonResponse(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createErrorResponse(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${getErrorMessage(error)}` }],
    isError: true as const,
  };
}

export function createTextResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}
