import { describe, it, expect } from 'vitest';
import {
  isBrandNewAccount,
  shouldShowVerificationNag,
  NEW_ACCOUNT_GRACE_MS,
  EMAIL_VERIFICATION_NAG_INTERVAL_MS,
} from './onboarding';

describe('isBrandNewAccount', () => {
  const now = 1_000_000_000_000; // fixed "now"

  it('returns false when createdAt is missing (absent after a rehydrate → not brand-new)', () => {
    expect(isBrandNewAccount(undefined, now)).toBe(false);
    expect(isBrandNewAccount(null, now)).toBe(false);
  });

  it('returns false for an unparseable createdAt', () => {
    expect(isBrandNewAccount('not-a-date', now)).toBe(false);
  });

  it('returns true when the account was created within the grace window', () => {
    const createdAt = new Date(now - (NEW_ACCOUNT_GRACE_MS - 1000)); // 1s inside the window
    expect(isBrandNewAccount(createdAt, now)).toBe(true);
  });

  it('returns false when the account was created outside the grace window', () => {
    const createdAt = new Date(now - (NEW_ACCOUNT_GRACE_MS + 1000)); // 1s past the window
    expect(isBrandNewAccount(createdAt, now)).toBe(false);
  });

  it('accepts ISO strings and epoch numbers, not just Date objects', () => {
    const createdMs = now - 60_000; // 1 min ago
    expect(isBrandNewAccount(new Date(createdMs).toISOString(), now)).toBe(true);
    expect(isBrandNewAccount(createdMs, now)).toBe(true);
  });

  it('is exclusive at exactly the grace boundary (not brand-new at the edge)', () => {
    expect(isBrandNewAccount(new Date(now - NEW_ACCOUNT_GRACE_MS), now)).toBe(false);
  });
});

describe('shouldShowVerificationNag', () => {
  const now = 1_000_000_000_000;

  it('shows when there is no prior dismissal', () => {
    expect(shouldShowVerificationNag(null, now)).toBe(true);
  });

  it('shows when the stored dismissal value is malformed', () => {
    expect(shouldShowVerificationNag('garbage', now)).toBe(true);
  });

  it('suppresses within the 24h nag interval', () => {
    const dismissedAt = String(now - (EMAIL_VERIFICATION_NAG_INTERVAL_MS - 1000)); // 1s inside
    expect(shouldShowVerificationNag(dismissedAt, now)).toBe(false);
  });

  it('shows again once the interval has elapsed', () => {
    const dismissedAt = String(now - (EMAIL_VERIFICATION_NAG_INTERVAL_MS + 1000)); // 1s past
    expect(shouldShowVerificationNag(dismissedAt, now)).toBe(true);
  });

  it('shows at exactly the interval boundary', () => {
    const dismissedAt = String(now - EMAIL_VERIFICATION_NAG_INTERVAL_MS);
    expect(shouldShowVerificationNag(dismissedAt, now)).toBe(true);
  });
});
