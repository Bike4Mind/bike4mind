import { describe, it, expect, vi } from 'vitest';
import speakeasy from 'speakeasy';
import { verifyMFA } from './verify';
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

// update echoes back the merged user so verifyMFA can return it
const makeRepo = () => ({ update: vi.fn(async (u: unknown) => u as IUserDocument) });

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
  });
});
