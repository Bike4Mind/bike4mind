import { describe, it, expect } from 'vitest';
import {
  PUBLISH_RATE_LIMITED,
  PUBLISH_RATE_LIMITS,
  formatPublishWait,
  publishRateLimitMessage,
} from './publishedArtifact';

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

describe('formatPublishWait', () => {
  it('rounds a wait of up to an hour up to whole minutes', () => {
    expect(formatPublishWait(61)).toBe('2 minutes');
    expect(formatPublishWait(42 * 60 - 30)).toBe('42 minutes');
    expect(formatPublishWait(3600)).toBe('60 minutes');
  });

  it('never says zero minutes, and reads one minute in the singular', () => {
    expect(formatPublishWait(1)).toBe('1 minute');
    expect(formatPublishWait(60)).toBe('1 minute');
    expect(formatPublishWait(0)).toBe('1 minute');
    expect(formatPublishWait(-5)).toBe('1 minute');
    expect(formatPublishWait(Number.NaN)).toBe('1 minute');
  });

  it('switches to approximate hours once the wait is over 60 minutes', () => {
    expect(formatPublishWait(3601)).toBe('about 1 hour');
    expect(formatPublishWait(89 * 60)).toBe('about 1 hour');
    expect(formatPublishWait(90 * 60)).toBe('about 2 hours');
    expect(formatPublishWait(12 * 3600 - 60)).toBe('about 12 hours');
    expect(formatPublishWait(24 * 3600)).toBe('about 24 hours');
  });
});

describe('publishRateLimitMessage', () => {
  it('words the wait in minutes up to an hour', () => {
    expect(publishRateLimitMessage(42 * 60)).toBe("You've published a lot today. Try again in 42 minutes.");
    expect(publishRateLimitMessage(30)).toBe("You've published a lot today. Try again in 1 minute.");
  });

  it('words the wait in hours beyond an hour', () => {
    expect(publishRateLimitMessage(5 * 3600)).toBe("You've published a lot today. Try again in about 5 hours.");
    expect(publishRateLimitMessage(3700)).toBe("You've published a lot today. Try again in about 1 hour.");
  });
});
