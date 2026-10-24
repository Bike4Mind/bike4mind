import { describe, it, expect } from 'vitest';
import { PUBLISH_RATE_LIMITED, PUBLISH_RATE_LIMITS } from './publishedArtifact';

describe('PUBLISH_RATE_LIMITS', () => {
  it('allows 200 publish actions per rolling 24 hours, and 20 for accounts younger than 7 days', () => {
    expect(PUBLISH_RATE_LIMITS).toEqual({
      windowMs: 24 * 60 * 60 * 1000,
      maxActions: 200,
      newAccount: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxActions: 20 },
    });
  });

  it('keeps the new-account allowance a positive whole number below the standard one', () => {
    const { maxActions, newAccount } = PUBLISH_RATE_LIMITS;
    expect(Number.isInteger(newAccount.maxActions)).toBe(true);
    expect(newAccount.maxActions).toBeGreaterThan(0);
    expect(newAccount.maxActions).toBeLessThan(maxActions);
  });

  it('names the refusal with a stable code clients can match on', () => {
    expect(PUBLISH_RATE_LIMITED).toBe('publish_rate_limited');
  });
});
