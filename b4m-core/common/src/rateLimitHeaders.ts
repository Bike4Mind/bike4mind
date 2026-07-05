/**
 * Rate Limit Header Parser
 *
 * Shared, integration-agnostic utility for parsing standard rate limit headers
 * from HTTP responses (GitHub, Atlassian, Slack, etc.).
 *
 * Supports both native fetch `Headers` and plain `Record<string, string>` objects.
 */

/** Canonical list of integrations tracked for rate limiting. Single source of truth. */
export const RATE_LIMIT_INTEGRATIONS = ['github', 'jira', 'confluence', 'slack'] as const;
export type RateLimitIntegrationType = (typeof RATE_LIMIT_INTEGRATIONS)[number];

export interface RateLimitInfo {
  /** Maximum requests allowed in the window (X-RateLimit-Limit) */
  limit: number | null;
  /** Requests remaining in the current window (X-RateLimit-Remaining) */
  remaining: number | null;
  /** When the rate limit window resets (X-RateLimit-Reset, converted from epoch) */
  resetAt: Date | null;
  /** Retry-After delay in milliseconds (from Retry-After header on 429) */
  retryAfterMs: number | null;
  /** Percentage of the rate limit consumed: (limit - remaining) / limit * 100 */
  usagePercent: number | null;
}

// Accept any header-like object: native Headers, Record<string, string>, or unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HeadersLike = any;

function getHeader(headers: HeadersLike, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') {
    // Native Headers or Headers-like object
    const val = headers.get(name);
    return typeof val === 'string' ? val : null;
  }
  // Plain object (Octokit response headers, Record<string, string>, etc.)
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function parseNumber(value: string | null): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse rate limit headers from an HTTP response.
 *
 * Reads standard headers:
 * - `X-RateLimit-Limit` - max requests per window
 * - `X-RateLimit-Remaining` - requests left
 * - `X-RateLimit-Reset` - Unix epoch seconds when the window resets
 * - `Retry-After` - seconds to wait (on 429 responses), or an HTTP-date
 */
export function parseRateLimitHeaders(headers: HeadersLike): RateLimitInfo {
  const limitStr = getHeader(headers, 'X-RateLimit-Limit') ?? getHeader(headers, 'x-ratelimit-limit');
  const remainingStr = getHeader(headers, 'X-RateLimit-Remaining') ?? getHeader(headers, 'x-ratelimit-remaining');
  const resetStr = getHeader(headers, 'X-RateLimit-Reset') ?? getHeader(headers, 'x-ratelimit-reset');
  const retryAfterStr = getHeader(headers, 'Retry-After') ?? getHeader(headers, 'retry-after');

  const limit = parseNumber(limitStr);
  const remaining = parseNumber(remainingStr);

  // Reset can be Unix epoch seconds (GitHub, Atlassian) or an HTTP-date
  let resetAt: Date | null = null;
  if (resetStr !== null) {
    const resetNum = Number(resetStr);
    if (Number.isFinite(resetNum)) {
      // Unix epoch seconds
      resetAt = new Date(resetNum * 1000);
    } else {
      // Try HTTP-date format (e.g., "Thu, 01 Dec 2025 16:00:00 GMT")
      const parsed = new Date(resetStr);
      if (!isNaN(parsed.getTime())) {
        resetAt = parsed;
      }
    }
  }

  // Retry-After: either seconds (number) or HTTP-date
  let retryAfterMs: number | null = null;
  if (retryAfterStr !== null) {
    const retryNum = Number(retryAfterStr);
    if (Number.isFinite(retryNum)) {
      retryAfterMs = retryNum * 1000;
    } else {
      const parsed = new Date(retryAfterStr);
      if (!isNaN(parsed.getTime())) {
        retryAfterMs = Math.max(0, parsed.getTime() - Date.now());
      }
    }
  }

  // Compute usage percentage (clamp remaining >= 0 to prevent >100% from misconfigured APIs)
  let usagePercent: number | null = null;
  if (limit !== null && limit > 0 && remaining !== null && remaining >= 0) {
    usagePercent = Math.round(((limit - remaining) / limit) * 100);
  }

  return { limit, remaining, resetAt, retryAfterMs, usagePercent };
}

/**
 * Returns true if the parsed headers contain any meaningful rate limit data.
 * Use this to avoid emitting empty log entries when the API response
 * doesn't include rate limit headers.
 */
export function hasRateLimitInfo(info: RateLimitInfo): boolean {
  return info.limit !== null || info.remaining !== null || info.retryAfterMs !== null;
}

/**
 * Check whether the current rate limit usage is near the threshold.
 *
 * @param info - Parsed rate limit info
 * @param thresholdPercent - Usage percentage threshold (default: 80)
 * @returns true if usage is at or above the threshold
 */
export function isNearLimit(info: RateLimitInfo, thresholdPercent = 80): boolean {
  if (info.usagePercent === null) return false;
  return info.usagePercent >= thresholdPercent;
}

/**
 * Normalize an endpoint path for use as a CloudWatch metric dimension.
 * Replaces dynamic segments (IDs, issue keys, etc.) with placeholders
 * to keep metric cardinality bounded.
 *
 * Examples:
 *   /issue/PROJ-123        -> /issue/{key}
 *   /pages/12345           -> /pages/{id}
 *   /repos/owner/repo/pulls -> /repos/{owner}/{repo}/pulls
 *   chat.postMessage       -> chat.postMessage (Slack methods pass through)
 */
export function normalizeEndpoint(endpoint: string): string {
  if (!endpoint || !endpoint.includes('/')) return endpoint;
  return endpoint
    .replace(/\/[A-Z][A-Z0-9]+-\d+/g, '/{key}') // Jira issue keys: PROJ-123
    .replace(/\/\d+/g, '/{id}') // Numeric IDs: /pages/12345
    .replace(/\/repos\/[^/]+\/[^/]+/, '/repos/{owner}/{repo}'); // GitHub owner/repo
}

/**
 * Build a structured log object for rate limit events.
 * Used by all integration clients to emit consistent log lines.
 */
export function buildRateLimitLogEntry(
  integration: string,
  endpoint: string,
  info: RateLimitInfo,
  wasThrottled = false
): Record<string, unknown> {
  return {
    type: wasThrottled ? 'RATE_LIMIT_ERROR' : 'RATE_LIMIT',
    integration,
    endpoint,
    limit: info.limit,
    remaining: info.remaining,
    resetAt: info.resetAt?.toISOString() ?? null,
    retryAfterMs: info.retryAfterMs,
    usagePercent: info.usagePercent,
    wasThrottled,
    timestamp: new Date().toISOString(),
  };
}
