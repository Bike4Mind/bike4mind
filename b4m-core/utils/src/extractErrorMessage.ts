/**
 * Coerce any thrown value into a human-readable string.
 *
 * Handles the three common shapes:
 *   - Error  -> .message
 *   - string -> as-is
 *   - other  -> JSON.stringify with a safe fallback for circular/unstringifiable values
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}
