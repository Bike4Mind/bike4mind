import { HTTPError, TooManyRequestsError } from '@bike4mind/common';

/** Sanitize error messages to avoid leaking internal details to clients */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Only pass through known safe error types (auth, validation, rate limit)
    if (
      error.message.includes('rate limit') ||
      error.message.includes('Authentication') ||
      error.message.includes('credit')
    ) {
      return error.message;
    }
  }
  return 'Internal server error';
}

/**
 * The error fields of a `cli_completion_error` frame. A 4xx is the caller's to fix, so it keeps its own
 * message and `errorCode` (as the SSE route's JSON envelope does); anything else is sanitized.
 */
export function cliCompletionErrorFields(error: unknown): { error: string; errorCode?: string; retryAfter?: number } {
  if (!(error instanceof HTTPError) || error.statusCode < 400 || error.statusCode >= 500) {
    return { error: sanitizeErrorMessage(error) };
  }
  const errorCode = error.additionalInfo?.errorCode;
  const retryAfter = error instanceof TooManyRequestsError ? error.additionalInfo?.retryAfter : undefined;
  return {
    error: error.message,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
  };
}
