import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/services', () => ({
  userService: {
    accountBlockReasons: (user: { reason?: string }) => (user.reason ? [user.reason] : []),
  },
}));

import { assertAccountStateUsable } from './assertAccountStateUsable';

describe('assertAccountStateUsable', () => {
  it('allows an account with no block reason', () => {
    expect(() => assertAccountStateUsable({} as never)).not.toThrow();
  });

  it.each([
    ['banned', 'User not found or banned'],
    ['disputePending', 'Account suspended pending dispute resolution'],
    ['suspended', 'Your account is suspended'],
  ])('rejects an account blocked for %s', (reason, message) => {
    expect(() => assertAccountStateUsable({ reason } as never)).toThrow(message);
  });
});
