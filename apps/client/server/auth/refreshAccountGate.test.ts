import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockRevokeSession } = vi.hoisted(() => ({ mockRevokeSession: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ authSessionRepository: {} }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    authSessionService: { revokeSession: (...a: unknown[]) => mockRevokeSession(...a) },
    // The real rule, so the refusal this guard mirrors cannot drift from the account-state source.
    userService: { accountBlockReasons: actual.userService.accountBlockReasons },
  };
});

import { UnauthorizedError, ForbiddenError } from '@server/utils/errors';
import { refuseBlockedRotatedSession } from './refreshAccountGate';

const USABLE = { isBanned: false, disputePending: false };

describe('refuseBlockedRotatedSession', () => {
  afterEach(() => {
    mockRevokeSession.mockClear();
    mockRevokeSession.mockReset();
  });

  it('lets a usable account through without touching the session', async () => {
    await refuseBlockedRotatedSession({ sid: 'sid-1', user: USABLE });

    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it.each([
    ['a banned', { isBanned: true }, UnauthorizedError],
    ['a disputed', { disputePending: true }, ForbiddenError],
    ['a suspended', { moderation: { status: 'suspended' } }, ForbiddenError],
  ])('revokes the rotated session and rethrows for %s account', async (_label, state, ErrorClass) => {
    await expect(refuseBlockedRotatedSession({ sid: 'sid-1', user: { ...USABLE, ...state } })).rejects.toBeInstanceOf(
      ErrorClass
    );

    expect(mockRevokeSession).toHaveBeenCalledWith('sid-1', expect.anything());
  });

  it('keeps the refusal, not the revoke failure, when the revoke throws', async () => {
    mockRevokeSession.mockRejectedValue(new Error('db down'));
    const logger = { error: vi.fn() };

    await expect(
      // any: only error() is read off the Logger here.
      refuseBlockedRotatedSession({ sid: 'sid-1', user: { isBanned: true } }, logger as any)
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect(logger.error).toHaveBeenCalled();
  });
});
