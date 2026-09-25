import { describe, expect, it } from 'vitest';
import { MIN_REFRESH_DELAY_MS, REFRESH_SKEW_MS, msUntilProactiveRefresh, msUntilRefreshRetry } from './refreshSchedule';

const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;

describe('msUntilProactiveRefresh', () => {
  it('fires ahead of expiry, not at it', () => {
    const now = Date.UTC(2026, 0, 1);
    const expiresAt = new Date(now + ACCESS_TOKEN_TTL_MS).toISOString();

    const delay = msUntilProactiveRefresh(expiresAt, now);

    expect(delay).toBe(ACCESS_TOKEN_TTL_MS - REFRESH_SKEW_MS);
    expect(delay).toBeLessThan(ACCESS_TOKEN_TTL_MS);
  });

  it('collapses to the floor for an expiry already inside the skew window', () => {
    const now = Date.UTC(2026, 0, 1);
    const expiresAt = new Date(now + 60_000).toISOString();

    expect(msUntilProactiveRefresh(expiresAt, now)).toBe(MIN_REFRESH_DELAY_MS);
  });

  it('never returns a negative delay for an already-expired token', () => {
    const now = Date.UTC(2026, 0, 1);

    expect(msUntilProactiveRefresh(new Date(now - ACCESS_TOKEN_TTL_MS).toISOString(), now)).toBe(MIN_REFRESH_DELAY_MS);
  });

  it('treats an unparseable expiry as due now rather than never', () => {
    expect(msUntilProactiveRefresh('not-a-date', Date.now())).toBe(MIN_REFRESH_DELAY_MS);
  });
});

describe('msUntilRefreshRetry', () => {
  it('backs off and then holds at a ceiling', () => {
    expect(msUntilRefreshRetry(1)).toBe(30_000);
    expect(msUntilRefreshRetry(2)).toBe(60_000);
    expect(msUntilRefreshRetry(3)).toBe(120_000);
    expect(msUntilRefreshRetry(10)).toBe(5 * 60 * 1000);
  });
});
