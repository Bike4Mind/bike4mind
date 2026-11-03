import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from './providerRateLimitError';

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('5', now)).toBe(5000);
  });

  it('reads an HTTP-date relative to now', () => {
    expect(parseRetryAfterMs('Fri, 23 Oct 2026 00:00:04 GMT', now)).toBe(4000);
  });

  it('clamps a past date to 0', () => {
    expect(parseRetryAfterMs('Thu, 22 Oct 2026 23:59:00 GMT', now)).toBe(0);
  });

  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs('soon', now)).toBeNull();
  });

  it('returns null for a malformed number rather than reading it as a past date', () => {
    expect(parseRetryAfterMs('3.5', now)).toBeNull();
    expect(parseRetryAfterMs('-1', now)).toBeNull();
  });
});
