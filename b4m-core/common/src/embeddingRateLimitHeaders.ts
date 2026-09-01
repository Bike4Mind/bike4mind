/**
 * Embedding-provider rate-limit headers.
 *
 * Deliberately separate from `parseRateLimitHeaders` in this package, which is GitHub-shaped:
 * ONE `X-RateLimit-Limit` dimension with an epoch-seconds reset. Embedding providers report TWO
 * independent dimensions - tokens and requests - and express reset as a DURATION ("6ms", "0s",
 * "6m0s") rather than an epoch. Folding them into one type would have made both callers carry
 * fields that mean nothing to them, so they stay apart.
 */

/** Header values as reported by the provider. Absent or unparseable fields are null, never 0 -
 *  "the provider did not say" and "the provider said zero" are different answers. */
export interface EmbeddingRateLimitSnapshot {
  /** Ceiling for the token dimension. Per-minute for OpenAI and VoyageAI. */
  limitTokens: number | null;
  /** Ceiling for the request dimension. Per-minute for OpenAI and VoyageAI. */
  limitRequests: number | null;
  remainingTokens: number | null;
  remainingRequests: number | null;
  /** Time until the token window resets, in ms. */
  resetTokensMs: number | null;
  /** Time until the request window resets, in ms. */
  resetRequestsMs: number | null;
}

// Accept native Headers or a plain record, matching parseRateLimitHeaders' tolerance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HeadersLike = any;

function getHeader(headers: HeadersLike, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return typeof value === 'string' ? value : null;
  }
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function parseCount(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
// `ms` must precede `m` in the alternation, or "6ms" would parse as 6 minutes followed by a
// stray "s" - a 60000x overstatement of how long the caller should wait.
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;

/**
 * Parse a Go-style duration ("6ms", "0s", "1m30s", "1h2m3s") to milliseconds.
 *
 * Exported for its own tests: it is the part of this module that can be wrong in a way the
 * numbers still look plausible.
 */
export function parseDurationMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  DURATION_PART.lastIndex = 0;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  for (const part of trimmed.matchAll(DURATION_PART)) {
    total += Number(part[1]) * UNIT_MS[part[2]];
    consumed += part[0].length;
    matched += 1;
  }
  // Every character must belong to a recognised unit. Without this, "12 parsecs" would read as
  // 12ms and a nonsense header would masquerade as a real reading.
  if (matched === 0 || consumed !== trimmed.length) return null;
  return total;
}

/** Read both rate-limit dimensions off a provider response. */
export function parseEmbeddingRateLimitHeaders(headers: HeadersLike): EmbeddingRateLimitSnapshot {
  return {
    limitTokens: parseCount(getHeader(headers, 'x-ratelimit-limit-tokens')),
    limitRequests: parseCount(getHeader(headers, 'x-ratelimit-limit-requests')),
    remainingTokens: parseCount(getHeader(headers, 'x-ratelimit-remaining-tokens')),
    remainingRequests: parseCount(getHeader(headers, 'x-ratelimit-remaining-requests')),
    resetTokensMs: parseDurationMs(getHeader(headers, 'x-ratelimit-reset-tokens')),
    resetRequestsMs: parseDurationMs(getHeader(headers, 'x-ratelimit-reset-requests')),
  };
}

/** True when the provider reported at least one usable ceiling. */
export function hasUsableLimits(snapshot: EmbeddingRateLimitSnapshot): boolean {
  return snapshot.limitTokens !== null || snapshot.limitRequests !== null;
}
