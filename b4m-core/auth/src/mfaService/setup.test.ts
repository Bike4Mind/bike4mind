import { describe, it, expect, vi } from 'vitest';
import speakeasy from 'speakeasy';
import { verifyMFASetup } from './setup';
import { MfaAttemptRejectedError } from './attempt';
import { hashBackupCode } from './utils';
import type { IUserDocument } from '@bike4mind/common';

const SECRET = speakeasy.generateSecret().base32;
// Stored codes are SHA-256 hashes; plaintext is only shown at setup time and never stored.
const BACKUP_CODES = ['ABCDE12345', 'FGHIJ67890'].map(hashBackupCode);

// Mirrors a user loaded via findByIdWithMfaSecrets: totpEnabled:false (setup in progress)
// but the hashed totpSecret + backupCodes ARE present (they are select:false in the DB).
const makePendingUser = (mfaOverride: Record<string, unknown> = {}): IUserDocument =>
  ({
    id: 'user-1',
    mfa: {
      totpEnabled: false,
      totpSecret: SECRET,
      backupCodes: [...BACKUP_CODES],
      setupAt: new Date(),
      ...mfaOverride,
    },
  }) as unknown as IUserDocument;

const reservedUser = { id: 'user-1', mfa: { failedAttempts: 1 } } as unknown as IUserDocument;
const lockedUser = {
  id: 'user-1',
  mfa: { failedAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) },
} as unknown as IUserDocument;

// update echoes back its argument so the service can return it. Reserve/claim default to success.
const makeRepo = (overrides: { reserved?: boolean; claimed?: boolean } = {}) => {
  const { reserved = true, claimed = true } = overrides;
  return {
    update: vi.fn(async (u: unknown) => u as IUserDocument),
    atomicReserveMfaAttempt: vi.fn(async () => ({ reserved, user: reserved ? reservedUser : lockedUser })),
    atomicClaimTotpStep: vi.fn(async () => claimed),
    atomicConsumeBackupCode: vi.fn(async () => true),
  };
};

const currentToken = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });

describe('verifyMFASetup', () => {
  it('enables MFA on a valid TOTP code', async () => {
    const result = await verifyMFASetup(makePendingUser(), currentToken(), makeRepo());
    expect(result.success).toBe(true);
  });

  it('rejects an invalid TOTP code without enabling MFA', async () => {
    await expect(verifyMFASetup(makePendingUser(), '000000', makeRepo())).rejects.toThrow(/Invalid/);
  });

  it('rejects an invalid code with MfaAttemptRejectedError carrying the reserved user', async () => {
    const repo = makeRepo();
    const error = await verifyMFASetup(makePendingUser(), '000000', repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('reserves the attempt before claiming the code', async () => {
    const repo = makeRepo();
    await verifyMFASetup(makePendingUser(), currentToken(), repo);
    expect(repo.atomicReserveMfaAttempt).toHaveBeenCalledWith('user-1');
    expect(repo.atomicReserveMfaAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      repo.atomicClaimTotpStep.mock.invocationCallOrder[0]
    );
  });

  it('throws MfaAttemptRejectedError with the locked user, and never claims or updates, when locked out', async () => {
    const repo = makeRepo({ reserved: false });
    const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(lockedUser);
    expect(repo.atomicClaimTotpStep).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects a replayed TOTP step with the reserved user as attemptState', async () => {
    const repo = makeRepo({ claimed: false });
    const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('claims the exact matched time step, not the current one', async () => {
    const nowMs = 1_700_000_000_000; // 20s into a 30s step, clear of the boundary
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const repo = makeRepo();
      const step = Math.floor(nowMs / 1000 / 30);
      const token = speakeasy.totp({ secret: SECRET, encoding: 'base32', time: Math.floor(nowMs / 1000) });
      await verifyMFASetup(makePendingUser(), token, repo);
      expect(repo.atomicClaimTotpStep).toHaveBeenCalledWith('user-1', step);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never writes a replay step in the enable update, even when the user has totpLastStep', async () => {
    const repo = makeRepo();
    const user = { ...makePendingUser(), totpLastStep: 7 } as unknown as IUserDocument;
    await verifyMFASetup(user, currentToken(), repo);
    const data = repo.update.mock.calls[0][0] as Record<string, unknown>;
    expect(data).not.toHaveProperty('totpLastStep');
    expect(data).not.toHaveProperty('mfa');
  });

  describe('failures after the attempt was reserved', () => {
    it('wraps a rejecting update, keeping the original error as cause', async () => {
      const repo = makeRepo();
      const cause = new Error('write failed');
      repo.update.mockRejectedValue(cause);
      const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect((error as MfaAttemptRejectedError).cause).toBe(cause);
    });

    it('wraps an update that returns null', async () => {
      const repo = makeRepo();
      repo.update.mockResolvedValue(null as never);
      const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect(((error as MfaAttemptRejectedError).cause as Error).message).toMatch(/Failed to enable/);
    });

    it('wraps a rejecting claim, keeping the original error as cause', async () => {
      const repo = makeRepo();
      const cause = new Error('claim failed');
      repo.atomicClaimTotpStep.mockRejectedValue(cause);
      const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect((error as MfaAttemptRejectedError).cause).toBe(cause);
    });
  });

  // Regression: enrolling MFA must not lose the secret. The endpoint used to clear failed
  // attempts in a separate update built from verifyMFASetup's (not-+selected) return value,
  // which wiped totpSecret/backupCodes via `$set: { mfa }` and left totpEnabled:true with no
  // secret - permanently bricking sign-in. The enable write now touches only the
  // attempt/lockout fields, so it never rewrites the `mfa` subdocument (or its secrets).
  it('enables MFA and clears attempt state with a field-level write that cannot wipe the secrets', async () => {
    const repo = makeRepo();
    const user = makePendingUser({ failedAttempts: 1, lastFailedAttempt: new Date() });
    await verifyMFASetup(user, currentToken(), repo);
    const [data, options] = repo.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { unset?: string[] },
    ];
    expect(data).not.toHaveProperty('mfa');
    expect(data['mfa.totpEnabled']).toBe(true);
    expect(data['mfa.failedAttempts']).toBe(0);
    expect(data['mfa.lastUsedAt']).toBeInstanceOf(Date);
    expect(options?.unset).toEqual(expect.arrayContaining(['mfa.lastFailedAttempt', 'mfa.lockedUntil']));
  });
});
