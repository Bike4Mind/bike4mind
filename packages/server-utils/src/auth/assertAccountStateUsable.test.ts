import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/services', () => ({
  userService: {
    accountBlockReasons: (user: { reason?: string }) => (user.reason ? [user.reason] : []),
  },
}));

vi.mock('../utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { assertAccountStateUsable } from './assertAccountStateUsable';

describe('assertAccountStateUsable', () => {
  it('allows an account with no block reason', () => {
    expect(() => assertAccountStateUsable({} as never)).not.toThrow();
  });

  it.each([
    ['banned', 'This account is suspended for violating our Terms of Service.'],
    ['disputePending', 'on hold pending a payment review'],
    ['suspended', 'Your account is suspended'],
  ])('rejects an account blocked for %s', (reason, message) => {
    expect(() => assertAccountStateUsable({ reason } as never)).toThrow(message);
  });

  it('refuses an expired persona with a 403', () => {
    const past = new Date(Date.now() - 60_000);
    expect(() => assertAccountStateUsable({ isPersona: true, personaExpiresAt: past } as never)).toThrow(
      'This test persona has expired.'
    );
  });

  it('allows a live persona', () => {
    const future = new Date(Date.now() + 60_000);
    expect(() => assertAccountStateUsable({ isPersona: true, personaExpiresAt: future } as never)).not.toThrow();
  });

  it('reports a banned persona as banned, not expired', () => {
    expect(() =>
      assertAccountStateUsable({ reason: 'banned', isPersona: true, personaExpiresAt: new Date(0) } as never)
    ).toThrow('suspended for violating our Terms of Service');
  });

  it('refuses an admin-suspended account with a classified 403 naming the category, never the signals', () => {
    let thrown: unknown;
    try {
      assertAccountStateUsable({ reason: 'banned', suspensionReasonCategory: 'multiple_accounts' } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('using multiple accounts to obtain free credits'),
      additionalInfo: { errorCode: 'account_suspended', suspension: { reason_category: 'multiple_accounts' } },
    });
  });
});
