import { describe, it, expect, vi } from 'vitest';
import speakeasy from 'speakeasy';
import { verifyMFASetup } from './setup';
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

// update echoes back its argument so the service can return it.
const makeRepo = () => ({ update: vi.fn(async (u: unknown) => u as IUserDocument) });

const currentToken = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });

describe('verifyMFASetup', () => {
  it('enables MFA on a valid TOTP code', async () => {
    const result = await verifyMFASetup(makePendingUser(), currentToken(), makeRepo());
    expect(result.success).toBe(true);
  });

  it('rejects an invalid TOTP code without enabling MFA', async () => {
    await expect(verifyMFASetup(makePendingUser(), '000000', makeRepo())).rejects.toThrow(/Invalid/);
  });

  // Regression: enrolling MFA must not lose the secret. The endpoint used to clear failed
  // attempts in a separate update built from verifyMFASetup's (not-+selected) return value,
  // which wiped totpSecret/backupCodes via `$set: { mfa }` and left totpEnabled:true with no
  // secret - permanently bricking sign-in. The single enable-write now preserves the secrets
  // and clears attempt/lockout state itself.
  it('preserves totpSecret/backupCodes and clears attempt state in the enable write', async () => {
    const repo = makeRepo();
    const user = makePendingUser({ failedAttempts: 1, lastFailedAttempt: new Date() });
    await verifyMFASetup(user, currentToken(), repo);
    const persisted = repo.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.mfa!.totpEnabled).toBe(true);
    expect(persisted.mfa!.totpSecret).toBe(SECRET);
    expect(persisted.mfa!.backupCodes).toEqual(BACKUP_CODES);
    expect(persisted.mfa!.failedAttempts).toBe(0);
    expect(persisted.mfa!.lastFailedAttempt).toBeUndefined();
  });
});
