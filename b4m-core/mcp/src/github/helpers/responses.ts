/**
 * GitHub MCP Server - Response Helpers
 *
 * Standardized response builders to eliminate repetitive JSON.stringify patterns.
 */

import type { McpResponse, GitHubApiError } from '../types.js';

/**
 * Create a success response with the given data
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
 * Sanitize GitHub API error details to prevent sensitive information disclosure.
 * Only expose safe, user-actionable information.
 */
function sanitizeErrorDetails(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const rawData = data as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  // Only include safe fields that help users understand the error
  if (typeof rawData.message === 'string') {
    sanitized.message = rawData.message;
  }
  if (typeof rawData.documentation_url === 'string') {
    sanitized.documentation_url = rawData.documentation_url;
  }
  // Include validation errors if present (helpful for fixing requests)
  if (Array.isArray(rawData.errors)) {
    sanitized.errors = rawData.errors
      .map((e: unknown) => {
        if (typeof e === 'object' && e !== null) {
          const err = e as Record<string, unknown>;
          return {
            resource: err.resource,
            field: err.field,
            code: err.code,
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

/**
 * Create an error response from an error object
 */
export function createErrorResponse(error: unknown, additionalData?: Record<string, unknown>): McpResponse {
  const err = error as GitHubApiError;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            success: false,
            error: err.message,
            status: err.status,
            details: sanitizeErrorDetails(err.response?.data),
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
 * Create an error response with a custom message (not from an Error object)
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
