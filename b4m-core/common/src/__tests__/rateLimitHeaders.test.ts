import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseRateLimitHeaders,
  isNearLimit,
  buildRateLimitLogEntry,
  normalizeEndpoint,
  resolveRetryAfterDelayMs,
  type RateLimitInfo,
} from '../rateLimitHeaders';

describe('parseRateLimitHeaders', () => {
  describe('with standard rate limit headers (GitHub/Atlassian)', () => {
    it('parses all rate limit headers from a Record', () => {
      const headers: Record<string, string> = {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4500',
        'x-ratelimit-reset': '1700000000',
      };

      const result = parseRateLimitHeaders(headers);

      expect(result.limit).toBe(5000);
      expect(result.remaining).toBe(4500);
      expect(result.resetAt).toEqual(new Date(1700000000 * 1000));
      expect(result.usagePercent).toBe(10);
      expect(result.retryAfterMs).toBeNull();
    });

    it('parses case-insensitive header names', () => {
      const headers: Record<string, string> = {
        'X-RateLimit-Limit': '1000',
        'X-RateLimit-Remaining': '200',
        'X-RateLimit-Reset': '1700000000',
      };

      const result = parseRateLimitHeaders(headers);

      expect(result.limit).toBe(1000);
      expect(result.remaining).toBe(200);
      expect(result.usagePercent).toBe(80);
    });

    it('parses from native Headers object', () => {
      const headers = new Headers();
      headers.set('X-RateLimit-Limit', '5000');
      headers.set('X-RateLimit-Remaining', '100');
      headers.set('X-RateLimit-Reset', '1700000000');

      const result = parseRateLimitHeaders(headers);

      expect(result.limit).toBe(5000);
      expect(result.remaining).toBe(100);
      expect(result.usagePercent).toBe(98);
    });
  });

  describe('usage percentage calculation', () => {
    it('computes 0% when no requests have been made', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '5000',
      });
      expect(result.usagePercent).toBe(0);
    });

    it('computes 100% when all requests are used', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
      });
      expect(result.usagePercent).toBe(100);
    });

    it('returns null when limit is missing', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-remaining': '100',
      });
      expect(result.usagePercent).toBeNull();
    });

    it('returns null when remaining is missing', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-limit': '5000',
      });
      expect(result.usagePercent).toBeNull();
    });

    it('returns null when limit is 0 (avoids division by zero)', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-limit': '0',
        'x-ratelimit-remaining': '0',
      });
      expect(result.usagePercent).toBeNull();
    });
  });

  describe('Retry-After header parsing', () => {
    it('parses numeric Retry-After (seconds)', () => {
      const result = parseRateLimitHeaders({
        'retry-after': '30',
      });
      expect(result.retryAfterMs).toBe(30000);
    });

    it('parses HTTP-date Retry-After', () => {
      const futureDate = new Date(Date.now() + 60000); // 60 seconds from now
      const result = parseRateLimitHeaders({
        'retry-after': futureDate.toUTCString(),
      });
      // Should be approximately 60000ms (allow some tolerance for test execution time)
      expect(result.retryAfterMs).toBeGreaterThan(55000);
      expect(result.retryAfterMs).toBeLessThan(65000);
    });

    it('returns 0ms for past HTTP-date Retry-After', () => {
      const pastDate = new Date(Date.now() - 10000);
      const result = parseRateLimitHeaders({
        'retry-after': pastDate.toUTCString(),
      });
      expect(result.retryAfterMs).toBe(0);
    });

    it('returns null when Retry-After is not present', () => {
      const result = parseRateLimitHeaders({});
      expect(result.retryAfterMs).toBeNull();
    });
  });

  describe('reset time parsing', () => {
    it('parses Unix epoch seconds', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-reset': '1700000000',
      });
      expect(result.resetAt).toEqual(new Date(1700000000 * 1000));
    });

    it('parses HTTP-date format', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-reset': 'Thu, 01 Dec 2025 16:00:00 GMT',
      });
      expect(result.resetAt).toEqual(new Date('Thu, 01 Dec 2025 16:00:00 GMT'));
    });

    it('returns null for invalid reset value', () => {
      const result = parseRateLimitHeaders({
        'x-ratelimit-reset': 'not-a-date',
      });
      expect(result.resetAt).toBeNull();
    });
  });

  describe('missing headers', () => {
    it('returns all nulls for empty headers', () => {
      const result = parseRateLimitHeaders({});
      expect(result).toEqual({
        limit: null,
        remaining: null,
        resetAt: null,
        retryAfterMs: null,
        usagePercent: null,
      });
    });

    it('returns all nulls for empty Headers object', () => {
      const result = parseRateLimitHeaders(new Headers());
      expect(result).toEqual({
        limit: null,
        remaining: null,
        resetAt: null,
        retryAfterMs: null,
        usagePercent: null,
      });
    });
  });
});

describe('isNearLimit', () => {
  it('returns true when usage is at default threshold (80%)', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 1000,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: 80,
    };
    expect(isNearLimit(info)).toBe(true);
  });

  it('returns true when usage exceeds threshold', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 500,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: 90,
    };
    expect(isNearLimit(info)).toBe(true);
  });

  it('returns false when usage is below threshold', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 4000,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: 20,
    };
    expect(isNearLimit(info)).toBe(false);
  });

  it('returns false when usagePercent is null', () => {
    const info: RateLimitInfo = {
      limit: null,
      remaining: null,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: null,
    };
    expect(isNearLimit(info)).toBe(false);
  });

  it('supports custom threshold', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 2500,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: 50,
    };
    expect(isNearLimit(info, 50)).toBe(true);
    expect(isNearLimit(info, 60)).toBe(false);
  });
});

describe('buildRateLimitLogEntry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a RATE_LIMIT log entry for normal requests', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 4500,
      resetAt: new Date('2025-06-15T13:00:00Z'),
      retryAfterMs: null,
      usagePercent: 10,
    };

    const entry = buildRateLimitLogEntry('github', '/repos/owner/repo', info);

    expect(entry.type).toBe('RATE_LIMIT');
    expect(entry.integration).toBe('github');
    expect(entry.endpoint).toBe('/repos/owner/repo');
    expect(entry.limit).toBe(5000);
    expect(entry.remaining).toBe(4500);
    expect(entry.resetAt).toBe('2025-06-15T13:00:00.000Z');
    expect(entry.usagePercent).toBe(10);
    expect(entry.wasThrottled).toBe(false);
    expect(entry.timestamp).toBe('2025-06-15T12:00:00.000Z');
  });

  it('builds a RATE_LIMIT_ERROR log entry when throttled', () => {
    const info: RateLimitInfo = {
      limit: 5000,
      remaining: 0,
      resetAt: null,
      retryAfterMs: 30000,
      usagePercent: 100,
    };

    const entry = buildRateLimitLogEntry('jira', '/issue/PROJ-1', info, true);

    expect(entry.type).toBe('RATE_LIMIT_ERROR');
    expect(entry.wasThrottled).toBe(true);
    expect(entry.retryAfterMs).toBe(30000);
  });

  it('handles null resetAt', () => {
    const info: RateLimitInfo = {
      limit: null,
      remaining: null,
      resetAt: null,
      retryAfterMs: null,
      usagePercent: null,
    };

    const entry = buildRateLimitLogEntry('slack', 'chat.postMessage', info);

    expect(entry.resetAt).toBeNull();
    expect(entry.limit).toBeNull();
    expect(entry.remaining).toBeNull();
  });
});

describe('resolveRetryAfterDelayMs (#2160)', () => {
  const info = (retryAfterMs: number | null): RateLimitInfo =>
    ({ limit: null, remaining: null, resetAt: null, retryAfterMs, usagePercent: null }) as RateLimitInfo;

  it('honours a positive hint over the default', () => {
    expect(resolveRetryAfterDelayMs(info(2000), 5000)).toBe(2000);
  });

  it('falls back to the default when there was no Retry-After at all', () => {
    expect(resolveRetryAfterDelayMs(info(null), 5000)).toBe(5000);
  });

  // The defect: `?? 5000` only replaces null/undefined, so a literal zero passed straight through
  // and the 429 retry fired after jitter alone (0-1s) against a service that had just asked for
  // room - bypassing a default whose own comment exists to "avoid hammering".
  it.each([
    ['an explicit zero', 0],
    ['a negative delay', -3000],
  ])('falls back to the default for %s rather than skipping the wait', (_label, value) => {
    expect(resolveRetryAfterDelayMs(info(value), 5000)).toBe(5000);
  });

  it('leaves the parsed value alone, so a zero is still visible to the logs', () => {
    // Deliberately not fixed in parseRateLimitHeaders: hasRateLimitInfo and buildRateLimitLogEntry
    // both read retryAfterMs, so nulling a zero there would make "the server sent Retry-After: 0"
    // indistinguishable from "the server sent none".
    const parsed = parseRateLimitHeaders({ 'retry-after': '0' });
    expect(parsed.retryAfterMs).toBe(0);
    expect(resolveRetryAfterDelayMs(parsed, 5000)).toBe(5000);
  });

  it('falls back for an HTTP date that has already elapsed', () => {
    const past = new Date(Date.now() - 4000).toUTCString();
    const parsed = parseRateLimitHeaders({ 'retry-after': past });
    // Math.max(0, ...) in the parser floors an elapsed date to zero.
    expect(parsed.retryAfterMs).toBe(0);
    expect(resolveRetryAfterDelayMs(parsed, 5000)).toBe(5000);
  });
});

describe('normalizeEndpoint', () => {
  it('replaces Jira issue keys with {key}', () => {
    expect(normalizeEndpoint('/issue/PROJ-123')).toBe('/issue/{key}');
    expect(normalizeEndpoint('/issue/TBI-61/transitions')).toBe('/issue/{key}/transitions');
  });

  it('replaces numeric IDs with {id}', () => {
    expect(normalizeEndpoint('/pages/12345')).toBe('/pages/{id}');
    expect(normalizeEndpoint('/spaces/67890/pages')).toBe('/spaces/{id}/pages');
  });

  it('replaces GitHub owner/repo with placeholders', () => {
    expect(normalizeEndpoint('/repos/MillionOnMars/lumina5/pulls')).toBe('/repos/{owner}/{repo}/pulls');
    expect(normalizeEndpoint('/repos/org/repo/issues/42')).toBe('/repos/{owner}/{repo}/issues/{id}');
  });

  it('passes through Slack method names unchanged', () => {
    expect(normalizeEndpoint('chat.postMessage')).toBe('chat.postMessage');
    expect(normalizeEndpoint('users.list')).toBe('users.list');
  });

  it('handles empty or missing endpoints', () => {
    expect(normalizeEndpoint('')).toBe('');
  });
});
