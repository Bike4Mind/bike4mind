import { describe, expect, it } from 'vitest';
import { hasUsableLimits, parseDurationMs, parseEmbeddingRateLimitHeaders } from './embeddingRateLimitHeaders';

/** Verbatim from a real text-embedding-ada-002 response. */
const LIVE_HEADERS = {
  'x-ratelimit-limit-requests': '10000',
  'x-ratelimit-limit-tokens': '10000000',
  'x-ratelimit-remaining-requests': '9999',
  'x-ratelimit-remaining-tokens': '9999998',
  'x-ratelimit-reset-requests': '6ms',
  'x-ratelimit-reset-tokens': '0s',
};

describe('parseDurationMs', () => {
  it.each([
    ['6ms', 6],
    ['0s', 0],
    ['1s', 1_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['1m30s', 90_000],
    ['1h2m3s', 3_723_000],
    ['1.5s', 1_500],
  ])('parses %s', (input, expected) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it('reads ms as milliseconds, not minutes', () => {
    // The single mistake that matters here: 'm' matching before 'ms' turns 6ms into 6 minutes,
    // a 60000x error that still looks like a plausible number downstream.
    expect(parseDurationMs('6ms')).toBe(6);
    expect(parseDurationMs('6m')).toBe(360_000);
  });

  it.each([[null], [undefined], [''], ['   '], ['soon'], ['12 parsecs'], ['6x']])(
    'returns null for unusable input %s',
    input => {
      expect(parseDurationMs(input as string)).toBeNull();
    }
  );

  it('rejects a duration with trailing junk rather than reading the prefix', () => {
    // Partial parsing would report 12ms for a header we do not actually understand.
    expect(parseDurationMs('12ms and then some')).toBeNull();
  });
});

describe('parseEmbeddingRateLimitHeaders', () => {
  it('reads both dimensions from a real provider response', () => {
    expect(parseEmbeddingRateLimitHeaders(LIVE_HEADERS)).toEqual({
      limitTokens: 10_000_000,
      limitRequests: 10_000,
      remainingTokens: 9_999_998,
      remainingRequests: 9_999,
      resetTokensMs: 0,
      resetRequestsMs: 6,
    });
  });

  it('accepts a native Headers object as well as a plain record', () => {
    const headers = new Headers(LIVE_HEADERS);
    expect(parseEmbeddingRateLimitHeaders(headers).limitTokens).toBe(10_000_000);
  });

  it('reports absent fields as null rather than 0', () => {
    // A caller comparing a lever against 0 would conclude the provider allows nothing.
    const snapshot = parseEmbeddingRateLimitHeaders({});
    expect(snapshot).toEqual({
      limitTokens: null,
      limitRequests: null,
      remainingTokens: null,
      remainingRequests: null,
      resetTokensMs: null,
      resetRequestsMs: null,
    });
  });

  it('keeps a genuine zero distinct from an absent value', () => {
    const snapshot = parseEmbeddingRateLimitHeaders({ 'x-ratelimit-remaining-tokens': '0' });
    expect(snapshot.remainingTokens).toBe(0);
    expect(snapshot.limitTokens).toBeNull();
  });

  it('tolerates a partial response, keeping the dimension the provider did report', () => {
    const snapshot = parseEmbeddingRateLimitHeaders({ 'x-ratelimit-limit-tokens': '1000000' });
    expect(snapshot.limitTokens).toBe(1_000_000);
    expect(snapshot.limitRequests).toBeNull();
  });

  it('does not confuse a non-numeric value for a reading', () => {
    expect(parseEmbeddingRateLimitHeaders({ 'x-ratelimit-limit-tokens': 'unlimited' }).limitTokens).toBeNull();
  });
});

describe('hasUsableLimits', () => {
  it('is true when either ceiling is present', () => {
    expect(hasUsableLimits(parseEmbeddingRateLimitHeaders(LIVE_HEADERS))).toBe(true);
    expect(hasUsableLimits(parseEmbeddingRateLimitHeaders({ 'x-ratelimit-limit-requests': '500' }))).toBe(true);
  });

  it('is false when the provider reported neither, even if it reported a reset', () => {
    expect(hasUsableLimits(parseEmbeddingRateLimitHeaders({ 'x-ratelimit-reset-tokens': '1s' }))).toBe(false);
  });
});
