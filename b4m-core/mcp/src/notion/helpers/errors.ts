/**
 * Notion MCP Server - Error Helpers
 *
 * Provides consistent error handling with sanitization
 * to prevent leaking raw API details to users.
 */

import type { NotionApiError } from '../types.js';

/**
 * Extracted error information with safe defaults.
 */
export interface ErrorInfo {
  message: string;
  status?: number;
  code?: string;
}

/**
 * Extract error information from an unknown error type.
 * Handles Error objects, Notion API errors, and unknown error shapes.
 */
export function getErrorInfo(error: unknown): ErrorInfo {
  if (error == null) {
    return { message: 'Unknown error' };
  }

  if (error instanceof Error) {
    const errWithMeta = error as Error & { status?: number; code?: string };
    return {
      message: error.message,
      status: typeof errWithMeta.status === 'number' ? errWithMeta.status : undefined,
      code: typeof errWithMeta.code === 'string' ? errWithMeta.code : undefined,
    };
  }

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;
    return {
      message: typeof err.message === 'string' ? err.message : 'Unknown error',
      status: typeof err.status === 'number' ? err.status : undefined,
      code: typeof err.code === 'string' ? err.code : undefined,
    };
  }

  if (typeof error === 'string') {
    return { message: error };
  }

  return { message: String(error) };
}

/**
 * Get just the error message from an unknown error type.
 */
export function getErrorMessage(error: unknown): string {
  return getErrorInfo(error).message;
}

/**
 * Type guard to check if an error has a specific status code.
 */
export function hasStatus(error: unknown, status: number): boolean {
  return getErrorInfo(error).status === status;
}

/**
 * Cast an unknown error to NotionApiError type.
 */
export function asNotionError(error: unknown): NotionApiError {
  return error as NotionApiError;
}
