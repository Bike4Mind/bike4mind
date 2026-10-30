import { HTTPError, TooManyRequestsError, type ICliCompletionErrorAction } from '@bike4mind/common';

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
 * The error fields of a `cli_completion_error` frame. Every HTTPError carries its `status` and `errorCode`
 * (as the SSE route's JSON envelope does); only a 4xx keeps its own message, since that is the caller's to
 * fix. Anything else is sanitized.
 */
export function cliCompletionErrorFields(
  error: unknown
): Pick<ICliCompletionErrorAction, 'error' | 'errorCode' | 'retryAfter' | 'status'> {
  if (!(error instanceof HTTPError)) return { error: sanitizeErrorMessage(error) };
  const errorCode = error.additionalInfo?.errorCode;
  const retryAfter = error instanceof TooManyRequestsError ? error.additionalInfo?.retryAfter : undefined;
  const callerError = error.statusCode >= 400 && error.statusCode < 500;
  return {
    error: callerError ? error.message : sanitizeErrorMessage(error),
    status: error.statusCode,
    ...(typeof errorCode === 'string' ? { errorCode } : {}),
    ...(typeof retryAfter === 'number' ? { retryAfter } : {}),
  };
}
