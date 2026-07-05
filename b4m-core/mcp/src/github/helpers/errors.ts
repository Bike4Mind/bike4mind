/**
 * GitHub MCP Server - Unified Error Helpers
 *
 * Provides consistent error handling patterns across all tool files.
 * Eliminates inconsistent error type assertions.
 */

import type { GitHubApiError } from '../types.js';

/**
 * Extracted error information with safe defaults
 */
export interface ErrorInfo {
  message: string;
  status?: number;
}

/**
 * Extract error information from an unknown error type.
 * Handles Error objects, GitHub API errors, and unknown error shapes.
 *
 * @example
 * try {
 *   await octokit.issues.create(...);
 * } catch (error) {
 *   const { message, status } = getErrorInfo(error);
 *   console.error(`[${TOOL_NAME}] ERROR: ${message}`);
 *   return createErrorResponse(error);
 * }
 */
export function getErrorInfo(error: unknown): ErrorInfo {
  // Handle null/undefined
  if (error == null) {
    return { message: 'Unknown error' };
  }

  // Handle Error instances
  if (error instanceof Error) {
    const status = (error as { status?: number }).status;
    return {
      message: error.message,
      status: typeof status === 'number' ? status : undefined,
    };
  }

  // Handle object-shaped errors (like GitHub API errors)
  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;
    return {
      message: typeof err.message === 'string' ? err.message : 'Unknown error',
      status: typeof err.status === 'number' ? err.status : undefined,
    };
  }

  // Handle string errors
  if (typeof error === 'string') {
    return { message: error };
  }

  // Fallback for any other type
  return { message: String(error) };
}

/**
 * Get the error message from an unknown error type.
 * Convenience function when only the message is needed.
 *
 * @example
 * console.error(`[${TOOL_NAME}] ERROR: ${getErrorMessage(error)}`);
 */
export function getErrorMessage(error: unknown): string {
  return getErrorInfo(error).message;
}

/**
 * Type guard to check if an error has a specific status code.
 *
 * @example
 * if (hasStatus(error, 404)) {
 *   return createCustomErrorResponse('Resource not found');
 * }
 */
export function hasStatus(error: unknown, status: number): boolean {
  return getErrorInfo(error).status === status;
}

/**
 * Type guard to check if an error is a rate limit error (status 403 with rate limit message).
 *
 * @example
 * if (isRateLimitError(error)) {
 *   return createCustomErrorResponse('Rate limit exceeded');
 * }
 */
export function isRateLimitError(error: unknown): boolean {
  const info = getErrorInfo(error);
  return info.status === 403 && info.message.toLowerCase().includes('rate limit');
}

/**
 * Cast an unknown error to GitHubApiError type.
 * Use this when you need to pass the error to createErrorResponse.
 *
 * Note: This is a type assertion, not a runtime check.
 * The createErrorResponse function handles unknown errors safely.
 */
export function asGitHubError(error: unknown): GitHubApiError {
  return error as GitHubApiError;
}
