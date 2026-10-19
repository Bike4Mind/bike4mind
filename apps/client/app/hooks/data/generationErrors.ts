/**
 * The error handling shared by every generation-job surface (video and music rate-limit the same way). Each kind
 * keeps its own `MESSAGES` map and calls describeGenerationError with it.
 */
import { isAxiosError } from 'axios';

export const GENERATION_RATE_LIMITED_MESSAGE = 'Too many requests. Wait a moment and try again.';

/** The `errorCode` on a response body, when it has one; the single reader every generation surface uses. */
export const readErrorCode = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && 'errorCode' in data ? data.errorCode : undefined;

/**
 * The user-facing message for a failed generation request: the shared rate-limit text, else the message for the
 * kind's own errorCode, else `fallback`. The response's `error` text is never shown - messages come from the code.
 */
export function describeGenerationError<TCode extends string>(
  codes: readonly TCode[],
  messages: Record<TCode, string>,
  error: unknown,
  fallback: string
): string {
  if (!isAxiosError(error)) return fallback;
  if (error.response?.status === 429) return GENERATION_RATE_LIMITED_MESSAGE;
  const code = readErrorCode(error.response?.data);
  if (typeof code === 'string' && (codes as readonly string[]).includes(code)) return messages[code as TCode];
  return fallback;
}
