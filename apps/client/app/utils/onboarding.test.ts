import { describe, it, expect } from 'vitest';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import {
  isAwaitingEmailVerification,
  isBrandNewAccount,
  resendVerificationErrorMessage,
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

describe('isAwaitingEmailVerification', () => {
  it('is true for an unverified user holding the pending-credits tag', () => {
    expect(isAwaitingEmailVerification({ emailVerified: false, tags: [PENDING_FREE_CREDITS_TAG] })).toBe(true);
  });

  it('is false once verified, even with the tag still present', () => {
    expect(isAwaitingEmailVerification({ emailVerified: true, tags: [PENDING_FREE_CREDITS_TAG] })).toBe(false);
  });

  it('is false for an unverified user without the tag, and for unknown verification state', () => {
    expect(isAwaitingEmailVerification({ emailVerified: false, tags: [] })).toBe(false);
    expect(isAwaitingEmailVerification({ emailVerified: null, tags: [PENDING_FREE_CREDITS_TAG] })).toBe(false);
  });

  it('is false with no user', () => {
    expect(isAwaitingEmailVerification(null)).toBe(false);
    expect(isAwaitingEmailVerification(undefined)).toBe(false);
  });
});

describe('resendVerificationErrorMessage', () => {
  it('names the 15 minute wait on a 429', () => {
    expect(resendVerificationErrorMessage({ response: { status: 429 } })).toMatch(/wait 15 minutes/i);
  });

  it('passes through the server message on a 503 config error, with a fallback when it has none', () => {
    expect(
      resendVerificationErrorMessage({
        response: { status: 503, data: { isConfigError: true, message: 'Not set up.' } },
      })
    ).toBe('Not set up.');
    expect(resendVerificationErrorMessage({ response: { status: 503, data: { isConfigError: true } } })).toBe(
      'Email service is not configured.'
    );
  });

  it('uses the response message for other errors, else a generic one', () => {
    expect(resendVerificationErrorMessage({ response: { status: 500, data: { message: 'Boom' } } })).toBe('Boom');
    expect(resendVerificationErrorMessage({})).toBe('Failed to send verification email. Please try again later.');
  });

  it('falls back when the server sends an empty error message', () => {
    expect(resendVerificationErrorMessage({ response: { status: 500, data: { message: '' } } })).toBe(
      'Failed to send verification email. Please try again later.'
    );
    expect(
      resendVerificationErrorMessage({ response: { status: 503, data: { isConfigError: true, message: '' } } })
    ).toBe('Email service is not configured.');
  });
});
