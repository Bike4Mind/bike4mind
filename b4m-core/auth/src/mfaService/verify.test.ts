import { describe, it, expect, vi } from 'vitest';
import speakeasy from 'speakeasy';
import { verifyMFA } from './verify';
import { MfaAttemptRejectedError } from './attempt';
import { hashBackupCode } from './utils';
import type { IUserDocument } from '@bike4mind/common';

const SECRET = speakeasy.generateSecret().base32;
// Backup codes are stored as SHA-256 hashes; plaintext is only shown at setup.
const BACKUP_CODE_PLAINTEXTS = ['ABCDE12345', 'FGHIJ67890'];
const BACKUP_CODES = BACKUP_CODE_PLAINTEXTS.map(hashBackupCode);

const makeUser = (mfaOverride: Record<string, unknown> = {}): IUserDocument =>
  ({
    id: 'user-1',
    mfa: {
      totpEnabled: true,
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

// update echoes back the merged user so verifyMFA can return it. Reserve/claim default to success.
const makeRepo = (overrides: { reserved?: boolean; claimed?: boolean } = {}) => {
  const { reserved = true, claimed = true } = overrides;
  return {
    update: vi.fn(async (u: unknown) => u as IUserDocument),
    atomicReserveMfaAttempt: vi.fn(async () => ({ reserved, user: reserved ? reservedUser : lockedUser })),
    atomicClaimTotpStep: vi.fn(async () => claimed),
  };
};

const currentToken = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });

describe('verifyMFA', () => {
  it('accepts a valid current TOTP code', async () => {
    const result = await verifyMFA({ user: makeUser(), token: currentToken() }, makeRepo());
    expect(result.verified).toBe(true);
    expect(result.usedBackupCode).toBeUndefined();
  });

  it('rejects an invalid code', async () => {
    // 'badtok' is neither a valid TOTP (non-numeric) nor a stored backup code.
    await expect(verifyMFA({ user: makeUser(), token: 'badtok' }, makeRepo())).rejects.toThrow(/Invalid/);
  });

  it('rejects an invalid code with MfaAttemptRejectedError carrying the reserved user, and never writes', async () => {
    const repo = makeRepo();
    const error = await verifyMFA({ user: makeUser(), token: 'badtok' }, repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.atomicClaimTotpStep).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('reserves the attempt before comparing the code', async () => {
    const repo = makeRepo();
    await verifyMFA({ user: makeUser(), token: currentToken() }, repo);
    expect(repo.atomicReserveMfaAttempt).toHaveBeenCalledWith('user-1');
    expect(repo.atomicReserveMfaAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      repo.atomicClaimTotpStep.mock.invocationCallOrder[0]
    );
  });

  it('throws MfaAttemptRejectedError with the locked user, and never claims or updates, when locked out', async () => {
    const repo = makeRepo({ reserved: false });
    const error = await verifyMFA({ user: makeUser(), token: currentToken() }, repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(lockedUser);
    expect(repo.atomicClaimTotpStep).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('locked out: a valid backup code is not accepted either', async () => {
    const repo = makeRepo({ reserved: false });
    await expect(verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo)).rejects.toBeInstanceOf(
      MfaAttemptRejectedError
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('treats a replayed TOTP step as invalid', async () => {
    const repo = makeRepo({ claimed: false });
    const error = await verifyMFA({ user: makeUser(), token: currentToken() }, repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('falls through to a backup code when the TOTP step was already claimed', async () => {
    const repo = makeRepo({ claimed: false });
    const result = await verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo);
    expect(result.usedBackupCode).toBe(hashBackupCode('ABCDE12345'));
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.mfa!.lastTotpStep).toBeUndefined();
  });

  it('writes the claimed step as lastTotpStep on TOTP success', async () => {
    const repo = makeRepo();
    await verifyMFA({ user: makeUser(), token: currentToken() }, repo);
    const claimedStep = repo.atomicClaimTotpStep.mock.calls[0][1] as number;
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.mfa!.lastTotpStep).toBe(claimedStep);
  });

  it('does not write lastTotpStep on backup-code success', async () => {
    const repo = makeRepo();
    await verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo);
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.mfa!.lastTotpStep).toBeUndefined();
  });

  it('accepts a backup code (case-insensitive) and consumes it', async () => {
    const repo = makeRepo();
    const result = await verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo);
    expect(result.verified).toBe(true);
    // usedBackupCode is the stored hash (used to filter it out of the array)
    expect(result.usedBackupCode).toBe(hashBackupCode('ABCDE12345'));
    // the used code's hash is removed from the persisted set; the other remains
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.mfa!.backupCodes).not.toContain(hashBackupCode('ABCDE12345'));
    expect(persisted.mfa!.backupCodes).toContain(hashBackupCode('FGHIJ67890'));
  });

  it('throws when MFA is not enabled for the user', async () => {
    await expect(
      verifyMFA({ user: makeUser({ totpEnabled: false }), token: currentToken() }, makeRepo())
    ).rejects.toThrow(/not enabled/);
  });

  // Regression: the select:false MFA-secret hardening bricked MFA because the endpoints
  // cleared failed attempts in a SEPARATE update built from verifyMFA's (not-+selected)
  // return value, wiping totpSecret/backupCodes via `$set: { mfa }`. The clear now happens
  // inside verifyMFA's single write, sourced from the secret-bearing input user.
  it('clears failed-attempt/lockout state AND preserves the secrets in the same write', async () => {
    const repo = makeRepo();
    const user = makeUser({
      failedAttempts: 2,
      lastFailedAttempt: new Date(),
      lockedUntil: new Date(Date.now() + 1000),
    });
    await verifyMFA({ user, token: currentToken() }, repo);
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    // Secrets must survive the write - this is the field that regressed.
    expect(persisted.mfa!.totpSecret).toBe(SECRET);
    expect(persisted.mfa!.backupCodes).toEqual(BACKUP_CODES);
    // Attempt/lockout state cleared in the SAME write (no secret-less follow-up update).
    expect(persisted.mfa!.failedAttempts).toBe(0);
    expect(persisted.mfa!.lockedUntil).toBeUndefined();
    expect(persisted.mfa!.lastFailedAttempt).toBeUndefined();
    expect(persisted.mfa!.lastUsedAt).toBeInstanceOf(Date);
  });
});
