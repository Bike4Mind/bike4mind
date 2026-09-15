/**
 * Notion MCP Server - Response Helpers
 *
 * Standardized response builders with error sanitization.
 */

import type { McpResponse } from '../types.js';
import { getErrorInfo } from './errors.js';

/**
 * Sanitize Notion API error details to prevent sensitive information disclosure.
 * Only expose safe, user-actionable fields.
 */
function sanitizeErrorMessage(message: string): string {
  // Strip anything that looks like a token or internal URL
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/ntn_[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]')
    .replace(/secret_[A-Za-z0-9_-]+/g, '[REDACTED_SECRET]');
}

/**
 * Create a success response with the given data.
 */
export function createSuccessResponse(data: Record<string, unknown>): McpResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, ...data }, null, 2),
      },
    ],
  };
}

/**
 * Create an error response from an error object, with sanitization.
 */
export function createErrorResponse(error: unknown, additionalData?: Record<string, unknown>): McpResponse {
  const info = getErrorInfo(error);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: false,
            error: sanitizeErrorMessage(info.message),
            ...(info.status ? { status: info.status } : {}),
            ...(info.code ? { code: info.code } : {}),
            ...additionalData,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

/**
 * Create an error response with a custom message (not from an Error object).
 */
export function createCustomErrorResponse(errorMessage: string, additionalData?: Record<string, unknown>): McpResponse {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: false,
            error: errorMessage,
            ...additionalData,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}
