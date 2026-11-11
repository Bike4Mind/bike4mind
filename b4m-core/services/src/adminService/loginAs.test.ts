import { describe, it, expect, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';

// Mock the MFA service - this test guards that loginAs LOADS the admin with secrets
// and hands that user to verifyMFA. Actual TOTP verification is covered by
// b4m-core/auth mfaService/verify.test.ts.
// Each test sets a secret-sensitive impl so a regression to a non-+select admin loader
// fails the test rather than passing tautologically.
const mockVerifyMFA = vi.fn();
vi.mock('@bike4mind/auth/mfaService', async () => {
  const { MfaAttemptRejectedError, isMfaAttemptRejectedError, recordFailedMfaAttempt } =
    await vi.importActual<typeof import('@bike4mind/auth/mfaService')>('@bike4mind/auth/mfaService');
  return {
    verifyMFA: (...a: unknown[]) => mockVerifyMFA(...a),
    isUserLockedOut: (user: { mfa?: { lockedUntil?: Date } } | null) => !!user?.mfa?.lockedUntil,
    getLockoutTimeRemaining: () => 0,
    MfaAttemptRejectedError,
    isMfaAttemptRejectedError,
    recordFailedMfaAttempt,
  };
});

import { MfaAttemptRejectedError } from '@bike4mind/auth/mfaService';
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

  it('counts a non-rejection verifier failure via atomicRecordMfaFailedAttempt', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockRejectedValue(new Error('db down'));
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());
    await expect(
      loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never)
    ).rejects.toThrow(/Invalid MFA token/);
    expect(mocks.atomicRecordMfaFailedAttempt).toHaveBeenCalledWith('admin1');
  });

  it('does not count a rejected attempt again (already reserved) and reports a plain invalid token', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockRejectedValue(
      new MfaAttemptRejectedError('Invalid TOTP or backup code.', freshAdminWithSecret())
    );
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());
    await expect(
      loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never)
    ).rejects.toThrow(/Invalid MFA token/);
    expect(mocks.atomicRecordMfaFailedAttempt).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reports a lockout from the rejection attemptState without counting again', async () => {
    vi.clearAllMocks();
    const locked = {
      ...freshAdminWithSecret(),
      mfa: { totpEnabled: true, lockedUntil: new Date(Date.now() + 60_000) },
    } as unknown as IUserDocument;
    mockVerifyMFA.mockRejectedValue(new MfaAttemptRejectedError('Too many failed attempts.', locked));
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());
    await expect(
      loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never)
    ).rejects.toThrow(/MFA locked/);
    expect(mocks.atomicRecordMfaFailedAttempt).not.toHaveBeenCalled();
  });
});

describe('adminService.loginAs - deletion-pending target', () => {
  it('refuses an account in its deletion grace period without notifying it', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockResolvedValue({ verified: true });
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());
    mocks.findById.mockResolvedValue({ ...targetUser, deletion: { scheduledFor: new Date() } } as never);

    await expect(
      loginAs(adminJwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never)
    ).rejects.toThrow('scheduled for deletion');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('adminService.loginAs - delegated users:impersonate', () => {
  const delegateJwt = {
    id: 'admin1',
    isAdmin: false,
    adminPermissions: ['users:impersonate'],
    mfa: { totpEnabled: true },
  } as unknown as IUserDocument;
  const freshDelegate = () =>
    ({
      ...freshAdminWithSecret(),
      isAdmin: false,
      adminPermissions: ['users:impersonate'],
    }) as unknown as IUserDocument;
  const run = (jwt: IUserDocument, adapters: unknown) =>
    loginAs(jwt, { targetUserId: 'target1', mfaToken: 'anytoken' }, adapters as never);

  it('lets a delegate with the permission impersonate a non-admin target', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockResolvedValue({ verified: true });
    const { adapters } = makeAdapters(freshDelegate());
    await expect(run(delegateJwt, adapters)).resolves.toBe(targetUser);
    expect(mockVerifyMFA).toHaveBeenCalled();
  });

  it('refuses a delegate on an admin target before notifying', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockResolvedValue({ verified: true });
    const { adapters, mocks } = makeAdapters(freshDelegate());
    mocks.findById.mockResolvedValue({ ...targetUser, adminPermissions: ['support:read'] } as never);
    await expect(run(delegateJwt, adapters)).rejects.toThrow('Only full administrators can impersonate');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('judges the admin target against the fresh record, not a stale full-admin JWT', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockResolvedValue({ verified: true });
    const { adapters, mocks } = makeAdapters(freshDelegate());
    mocks.findById.mockResolvedValue({ ...targetUser, isAdmin: true } as never);
    await expect(run(adminJwt, adapters)).rejects.toThrow('Only full administrators can impersonate');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('still lets a full admin impersonate an admin target', async () => {
    vi.clearAllMocks();
    mockVerifyMFA.mockResolvedValue({ verified: true });
    const { adapters, mocks } = makeAdapters(freshAdminWithSecret());
    const adminTarget = { ...targetUser, isAdmin: true } as unknown as IUserDocument;
    mocks.findById.mockResolvedValue(adminTarget);
    await expect(run(adminJwt, adapters)).resolves.toBe(adminTarget);
  });

  it('refuses a delegate without the permission before MFA is verified', async () => {
    vi.clearAllMocks();
    const jwt = { ...delegateJwt, adminPermissions: ['support:read'] } as unknown as IUserDocument;
    const { adapters } = makeAdapters(freshDelegate());
    await expect(run(jwt, adapters)).rejects.toThrow('Missing permission: users:impersonate');
    expect(mockVerifyMFA).not.toHaveBeenCalled();
  });

  it('refuses when the fresh record no longer holds the permission', async () => {
    vi.clearAllMocks();
    const stale = { ...freshDelegate(), adminPermissions: [] } as unknown as IUserDocument;
    const { adapters } = makeAdapters(stale);
    await expect(run(delegateJwt, adapters)).rejects.toThrow('Missing permission: users:impersonate');
    expect(mockVerifyMFA).not.toHaveBeenCalled();
  });
});
