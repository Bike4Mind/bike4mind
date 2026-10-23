/**
 * A provider refused a request with HTTP 429 (rate or concurrency limit). Thrown instead of a plain
 * `Error` so callers can tell "busy, retry shortly" apart from a real failure without parsing the
 * message - see runWithProviderCapacity in @bike4mind/services, which retries it.
 */
export class ProviderRateLimitError extends Error {
  readonly status = 429;

  constructor(
    readonly provider: string,
    message: string,
    /** The provider's `Retry-After` hint in ms, when it sent a usable one. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

/**
 * Parses a `Retry-After` header (delta-seconds or an HTTP-date) into ms from `now`. Returns null when
 * the header is absent or unparseable, and clamps a date in the past to 0.
 */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always names its month; without this Date.parse reads '3.5' or '-1' as a past date
  // and the caller would retry with no backoff at all.
  if (!/[a-z]/i.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
