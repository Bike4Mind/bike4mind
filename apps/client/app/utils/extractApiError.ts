/** Pull a human message out of an axios-style error, falling back to a generic string. */
export function extractApiError(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { message?: string; error?: string } } }).response;
    const message = response?.data?.message ?? response?.data?.error;
    if (message) return message;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}
