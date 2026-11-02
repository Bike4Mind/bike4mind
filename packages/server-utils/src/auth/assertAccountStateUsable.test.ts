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
    ['banned', 'User not found or banned'],
    ['disputePending', 'Account suspended pending dispute resolution'],
    ['suspended', 'Your account is suspended'],
  ])('rejects an account blocked for %s', (reason, message) => {
    expect(() => assertAccountStateUsable({ reason } as never)).toThrow(message);
  });

  it('refuses a deletion-pending account by default (API key, CLI, WebSocket, embed)', () => {
    expect(() => assertAccountStateUsable({ reason: 'deletionPending' } as never)).toThrow(/scheduled for deletion/);
  });

  it('admits a deletion-pending account on the browser session surfaces', () => {
    expect(() =>
      assertAccountStateUsable({ reason: 'deletionPending' } as never, { allowDeletionPending: true })
    ).not.toThrow();
  });

  it('still refuses a suspended account when deletion-pending accounts are allowed', () => {
    expect(() => assertAccountStateUsable({ reason: 'suspended' } as never, { allowDeletionPending: true })).toThrow(
      'Your account is suspended'
    );
  });
});
