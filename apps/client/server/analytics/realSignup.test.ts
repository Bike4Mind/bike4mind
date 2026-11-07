import { describe, it, expect } from 'vitest';
import { REAL_SIGNUP_WINDOW_DAYS, realSignupVerdictOf } from './realSignup';

const ctx = { staffRegex: null, testDomains: [] };
const createdAt = new Date('2026-06-01T00:00:00Z');
const user = { _id: 'u', createdAt, emailVerified: true };
const after = (ms: number) => new Date(createdAt.getTime() + ms);
const HOUR = 3_600_000;
const WINDOW = REAL_SIGNUP_WINDOW_DAYS * 24 * HOUR;

describe('realSignupVerdictOf', () => {
  it('is real for a verified account with a request just inside the window', () => {
    expect(realSignupVerdictOf(user, after(WINDOW - HOUR), ctx)).toBe('legit');
  });

  it.each([
    ['unverified', { emailVerified: false }, after(HOUR)],
    ['banned', { isBanned: true }, after(HOUR)],
    ['moderated', { isModerated: true }, after(HOUR)],
    ['review pending', { riskScore: { reviewState: 'pending' } }, after(HOUR)],
    ['request at exactly +7d', {}, after(WINDOW)],
    ['request after the window', {}, after(WINDOW + HOUR)],
    ['no request', {}, undefined],
  ])('is suspected when %s', (_name, extra, firstRequestAt) => {
    expect(realSignupVerdictOf({ ...user, ...extra }, firstRequestAt, ctx)).toBe('suspected');
  });
});
