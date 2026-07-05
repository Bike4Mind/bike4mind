import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// Mock the MFA service - this test guards that loginAs LOADS the admin with secrets
// and hands that user to verifyMFA. Actual TOTP verification is covered by
// b4m-core/auth mfaService/verify.test.ts.
// Each test sets a secret-sensitive impl so a regression to a non-+select admin loader
// fails the test rather than passing tautologically.
const mockVerifyMFA = vi.fn();
vi.mock('@bike4mind/auth/mfaService', () => ({
  verifyMFA: (...a: unknown[]) => mockVerifyMFA(...a),
  clearFailedAttempts: () => null,
  isUserLockedOut: () => false,
  getLockoutTimeRemaining: () => 0,
}));

import { loginAs } from './loginAs';

const adminJwt = { id: 'admin1', isAdmin: true, mfa: { totpEnabled: true } } as unknown as IUserDocument;
const targetUser = { id: 'target1', isSystem: false, username: 'target' } as unknown as IUserDocument;

// The admin as loaded from the DB WITH the select:false secret (correct behavior).
const freshAdminWithSecret = () =>
  ({
    id: 'admin1',
    isAdmin: true,
    mfa: { totpEnabled: true, totpSecret: 'SECRET', backupCodes: [], setupAt: new Date(), failedAttempts: 0 },
  }) as unknown as IUserDocument;

const makeAdapters = (freshAdmin: IUserDocument | null) => {
  const findByIdWithMfaSecrets = vi.fn(async () => freshAdmin);
  const findById = vi.fn(async () => targetUser);
  const update = vi.fn(async (u: unknown) => u as IUserDocument);
  // Atomic failed-attempt recorder used by the MFA-failure path; returns the admin doc so
  // the subsequent isUserLockedOut() check runs against a real object.
  const atomicRecordMfaFailedAttempt = vi.fn(async () => freshAdmin);
  const send = vi.fn(async () => {});
  return {
    adapters: {
      db: { users: { findByIdWithMfaSecrets, findById, update, atomicRecordMfaFailedAttempt } },
      notify: { send },
    },
    mocks: { findByIdWithMfaSecrets, findById, update, atomicRecordMfaFailedAttempt, send },
  };
};

describe('adminService.loginAs — MFA secret loading', () => {
  it('loads the admin via findByIdWithMfaSecrets and passes the secret-bearing user to verifyMFA', async () => {
    vi.clearAllMocks();
    // Secret-sensitive: fails if the admin was loaded without totpSecret - so a
    // regression to a non-+select loader makes THIS positive test fail, not just pass.
    mockVerifyMFA.mockImplementation(async ({ user }: { user: IUserDocument }) => {
      if (!user?.mfa?.totpSecret) throw new Error('Invalid TOTP or backup code.');
      return { verified: true, user };
    });
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());

    const result = await loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never);

    // Regression guard: admin loaded via the +select method (NOT findById), so the
    // secret is present for verification.
    expect(mocks.findByIdWithMfaSecrets).toHaveBeenCalledWith('admin1');
    const verifyArg = mockVerifyMFA.mock.calls[0][0] as { user: IUserDocument };
    expect(verifyArg.user.mfa?.totpSecret).toBe('SECRET');
    expect(result).toBe(targetUser);
    expect(mocks.send).toHaveBeenCalledWith(targetUser);
  });

  it('throws Invalid MFA token when verification fails', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockRejectedValue(new Error('Invalid TOTP or backup code.'));
    const { adapters } = makeAdapters(freshAdminWithSecret());
    await expect(
      loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never)
    ).rejects.toThrow(/Invalid MFA token/);
  });
});
