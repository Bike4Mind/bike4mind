/**
 * Request-ID correlation utilities - single source of truth for the
 * X-Request-ID identifier shared by the Next.js and Lambda transports.
 */

/**
 * Canonical correlation header, echoed on every response.
 *
 * NOTE: the mixed-case spelling is correct as a response header key, but Node
 * and API Gateway lowercase every inbound header key - so when reading it off
 * an incoming request always use `headers[REQUEST_ID_HEADER.toLowerCase()]`; a
 * direct `headers[REQUEST_ID_HEADER]` lookup silently misses.
 */
export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Deprecated header name still accepted on inbound requests.
 *
 * NOTE: the canonical mixed-case spelling is kept for display only. Node and
 * API Gateway lowercase every inbound header key, so always read it via
 * `headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]` - a direct
 * `headers[LEGACY_REQUEST_ID_HEADER]` lookup silently misses.
 */
export const LEGACY_REQUEST_ID_HEADER = 'Request-ID';

/** Max length of a caller-supplied request ID after sanitization. */
export const MAX_REQUEST_ID_LENGTH = 128;

const UNSAFE_REQUEST_ID_CHARS = /[^A-Za-z0-9._-]/g;

/** Generate a fresh request ID (UUID v4). */
export function generateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Sanitize a caller-supplied request ID. Stripping everything outside the
 * allowlist also removes CR/LF, which is what prevents log injection when
 * the value is later written to logs. Returns null when nothing usable
 * remains so the caller can fall back to a generated ID.
 */
export function sanitizeRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(UNSAFE_REQUEST_ID_CHARS, '').slice(0, MAX_REQUEST_ID_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Resolve the request ID for an incoming request: the first caller-supplied
 * candidate that survives sanitization, otherwise a freshly generated one.
 */
export function resolveRequestId(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const sanitized = sanitizeRequestId(candidate);
    if (sanitized) return sanitized;
  }
  return generateRequestId();
}
