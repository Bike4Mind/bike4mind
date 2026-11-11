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
