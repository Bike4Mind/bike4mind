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
