import { describe, it, expect, beforeEach } from 'vitest';
import { User, userRepository } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards the security property that plaintext MFA secrets (totpSecret, backupCodes)
 * are select:false - excluded from default queries/responses so they never reach a
 * client - while findByIdWithMfaSecrets (+select) still loads them for server-side
 * verification. This is the exact mechanism that regressed adminService.loginAs.
 */
describe('MFA secret field selection (select:false)', () => {
  setupMongoTest();

  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  const BACKUP_CODES = ['ABCDE12345', 'FGHIJ67890'];
  let userId: string;

  beforeEach(async () => {
    await User.deleteMany({});
    const u = await User.create({
      username: 'mfa-user',
      email: 'mfa-user@example.com',
      name: 'MFA User',
      mfa: { totpEnabled: true, totpSecret: TOTP_SECRET, backupCodes: BACKUP_CODES, setupAt: new Date() },
    });
    userId = u.id;
  });

  it('findByEmail omits totpSecret/backupCodes but keeps the non-secret totpEnabled flag', async () => {
    const u = await userRepository.findByEmail('mfa-user@example.com');
    expect(u).toBeTruthy();
    expect(u!.mfa?.totpEnabled).toBe(true);
    expect(u!.mfa?.totpSecret).toBeUndefined();
    expect(u!.mfa?.backupCodes ?? []).toHaveLength(0);
  });

  it('findById omits totpSecret/backupCodes', async () => {
    const u = await userRepository.findById(userId);
    expect(u!.mfa?.totpSecret).toBeUndefined();
    expect(u!.mfa?.backupCodes ?? []).toHaveLength(0);
  });

  it('findByIdWithMfaSecrets loads totpSecret/backupCodes for verification', async () => {
    const u = await userRepository.findByIdWithMfaSecrets(userId);
    expect(u!.mfa?.totpSecret).toBe(TOTP_SECRET);
    expect(u!.mfa?.backupCodes).toEqual(BACKUP_CODES);
  });

  // Regression guard for the MFA-secret wipe. An update persists `mfa` via `$set: { mfa }`,
  // which REPLACES the whole subdocument, so rebuilding `mfa` from a read that did not load
  // the select:false secrets would ERASE totpSecret/backupCodes - the exact mechanism that
  // bricked MFA enrollment, login, admin loginAs, backup-code regeneration, AND every
  // whole-user write (profile/email/storage edits) that spreads a secret-less user. A
  // schema-level pre-update hook guards this by dropping any secret-less `mfa` object from
  // the update, covering both repository writes and direct model calls.
  describe('User schema guards select:false MFA secrets on update', () => {
    it('drops a secret-less mfa object so the stored secrets survive the write', async () => {
      // Rebuild mfa from a secret-less read (no totpSecret) and write it - the footgun.
      const secretless = await userRepository.findById(userId);
      const rewritten = { ...secretless!.mfa, failedAttempts: 0 };
      await userRepository.update({ id: userId, mfa: rewritten as any });

      const after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.mfa?.totpEnabled).toBe(true);
      // Guard dropped the secret-less mfa write -> stored secrets untouched (no lockout).
      expect(after!.mfa?.totpSecret).toBe(TOTP_SECRET);
      expect(after!.mfa?.backupCodes).toEqual(BACKUP_CODES);
    });

    it('guards DIRECT model writes that bypass the repository (updateOne / findByIdAndUpdate)', async () => {
      // The bypass the repository-level guard missed: a direct model write that carries a
      // secret-less mfa alongside the field it actually meant to change (the real-world shape).
      await User.updateOne(
        { _id: userId },
        { $set: { mfa: { totpEnabled: true, failedAttempts: 3 }, currentStorageSize: 111 } }
      );
      let after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.currentStorageSize).toBe(111); // the intended change still applied
      expect(after!.mfa?.totpSecret).toBe(TOTP_SECRET); // hook stripped only the secret-less mfa
      expect(after!.mfa?.backupCodes).toEqual(BACKUP_CODES);

      // Also the top-level (non-$set) form.
      await User.findByIdAndUpdate(userId, { mfa: { totpEnabled: true }, currentStorageSize: 222 });
      after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.currentStorageSize).toBe(222);
      expect(after!.mfa?.totpSecret).toBe(TOTP_SECRET);
    });

    it('preserves MFA secrets on a realistic whole-user update from a secret-less read', async () => {
      // The exact sibling-path scenario (e.g. recalculateUserStorage / profile / email change):
      // load the user without secrets, change an unrelated field, write the whole user back.
      const user = await userRepository.findById(userId);
      (user as any).currentStorageSize = 12345;
      await userRepository.update(user as any);

      const after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.currentStorageSize).toBe(12345); // the intended change still applied
      expect(after!.mfa?.totpSecret).toBe(TOTP_SECRET); // ...and MFA was not bricked
      expect(after!.mfa?.backupCodes).toEqual(BACKUP_CODES);
    });

    it('still persists a deliberate mfa write that carries the secrets', async () => {
      const withSecrets = await userRepository.findByIdWithMfaSecrets(userId);
      const rewritten = { ...withSecrets!.mfa, backupCodes: ['NEWCODE001', 'NEWCODE002'], lastUsedAt: new Date() };
      await userRepository.update({ id: userId, mfa: rewritten as any });

      const after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.mfa?.totpSecret).toBe(TOTP_SECRET);
      expect(after!.mfa?.backupCodes).toEqual(['NEWCODE001', 'NEWCODE002']); // deliberate change applied
    });

    it('still allows deliberate teardown with mfa: null', async () => {
      await userRepository.update({ id: userId, mfa: null } as any);
      const after = await userRepository.findByIdWithMfaSecrets(userId);
      expect(after!.mfa ?? null).toBeNull();
    });
  });
});
