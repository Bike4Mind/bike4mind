import { describe, it, expect, vi } from 'vitest';
import speakeasy from 'speakeasy';
import { PENDING_SECRET_REUSE_MS, setupMFA, verifyMFASetup } from './setup';
import { MfaAttemptRejectedError } from './attempt';
import { hashBackupCode } from './utils';
import type { IUserDocument } from '@bike4mind/common';

const SECRET = speakeasy.generateSecret().base32;
// Stored codes are SHA-256 hashes; plaintext is only shown at setup time and never stored.
const PLAIN_CODES = ['ABCDE12345', 'FGHIJ67890'];
const BACKUP_CODES = PLAIN_CODES.map(hashBackupCode);

// Mirrors a user loaded via findByIdWithMfaSecrets: totpEnabled:false (setup in progress)
// but the hashed totpSecret + backupCodes ARE present (they are select:false in the DB).
const makePendingUser = (mfaOverride: Record<string, unknown> = {}): IUserDocument =>
  ({
    id: 'user-1',
    mfa: {
      totpEnabled: false,
      totpSecret: SECRET,
      backupCodes: [...BACKUP_CODES],
      pendingBackupCodes: PLAIN_CODES.join(','),
      setupAt: new Date(),
      ...mfaOverride,
    },
  }) as unknown as IUserDocument;

const reservedUser = { id: 'user-1', mfa: { failedAttempts: 1 } } as unknown as IUserDocument;
const lockedUser = {
  id: 'user-1',
  mfa: { failedAttempts: 3, lockedUntil: new Date(Date.now() + 60_000) },
} as unknown as IUserDocument;
const enabledUser = { id: 'user-1', mfa: { totpEnabled: true } } as unknown as IUserDocument;

// Reserve/claim/enable default to success. `atomicEnableMfa` echoes an enabled user the way the
// repository's findOneAndUpdate does; a null return means the secret had been replaced.
const makeRepo = (overrides: { reserved?: boolean; claimed?: boolean; enabled?: boolean } = {}) => {
  const { reserved = true, claimed = true, enabled = true } = overrides;
  return {
    atomicReserveMfaAttempt: vi.fn(async () => ({ reserved, user: reserved ? reservedUser : lockedUser })),
    atomicClaimTotpStep: vi.fn(async () => claimed),
    atomicConsumeBackupCode: vi.fn(async () => true),
    atomicEnableMfa: vi.fn(async () => (enabled ? enabledUser : null)),
  };
};

const currentToken = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });

describe('setupMFA', () => {
  const makeUpdate = () => vi.fn(async (u: unknown) => u as IUserDocument);
  const written = (update: ReturnType<typeof makeUpdate>) =>
    update.mock.calls[0][0] as unknown as {
      mfa: { totpSecret: string; backupCodes: string[]; pendingBackupCodes: string; setupAt: Date };
    } & Record<string, unknown>;
  const noSetup = { id: 'user-1' } as unknown as IUserDocument;

  it('clears the stored TOTP step when it issues a new secret, so its codes are not refused as replays', async () => {
    const update = makeUpdate();
    await setupMFA({ user: noSetup, appName: 'Test App' }, { update });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1', totpLastStep: null }));
  });

  it('stores a plaintext copy of the issued codes beside their hashes, for a repeat call to re-serve', async () => {
    const update = makeUpdate();
    const result = await setupMFA({ user: noSetup, appName: 'Test App' }, { update });
    expect(written(update).mfa.backupCodes).toEqual(result.backupCodes.map(hashBackupCode));
    expect(written(update).mfa.pendingBackupCodes).toBe(result.backupCodes.join(','));
  });

  it('re-serves a recent pending secret and its backup codes, so what the user scanned and saved stays valid', async () => {
    const setupAt = new Date(Date.now() - 5 * 60_000);
    const update = makeUpdate();

    const result = await setupMFA({ user: makePendingUser({ setupAt }), appName: 'Test App' }, { update });

    expect(result.secret).toBe(SECRET);
    expect(result.manualEntryKey).toBe(SECRET);
    expect(result.backupCodes).toEqual(PLAIN_CODES);
    expect(written(update).mfa).toMatchObject({
      totpSecret: SECRET,
      backupCodes: BACKUP_CODES,
      pendingBackupCodes: PLAIN_CODES.join(','),
      setupAt,
    });
  });

  it('keeps the stored TOTP step on reuse, so a code a concurrent verify claimed is not accepted again', async () => {
    const update = makeUpdate();
    await setupMFA({ user: makePendingUser(), appName: 'Test App' }, { update });
    expect(written(update)).not.toHaveProperty('totpLastStep');
  });

  it('issues a new secret and codes once the pending one is past the reuse window', async () => {
    const setupAt = new Date(Date.now() - PENDING_SECRET_REUSE_MS - 1000);
    const update = makeUpdate();

    const result = await setupMFA({ user: makePendingUser({ setupAt }), appName: 'Test App' }, { update });

    expect(result.secret).not.toBe(SECRET);
    expect(result.backupCodes).not.toEqual(PLAIN_CODES);
    expect(written(update).mfa.setupAt.getTime()).toBeGreaterThan(setupAt.getTime());
  });

  it('issues a new secret and codes when the pending setup has no stored codes to re-serve', async () => {
    const update = makeUpdate();

    const result = await setupMFA(
      { user: makePendingUser({ pendingBackupCodes: undefined }), appName: 'Test App' },
      { update }
    );

    expect(result.secret).not.toBe(SECRET);
    expect(written(update)).toHaveProperty('totpLastStep', null);
  });

  it.each([
    ['secret', { totpSecret: '' }],
    ['backup codes', { pendingBackupCodes: '' }],
  ])('issues a new secret and codes when the stored %s could not be decrypted', async (_label, override) => {
    const update = makeUpdate();

    const result = await setupMFA({ user: makePendingUser(override), appName: 'Test App' }, { update });

    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(result.secret).not.toBe(SECRET);
    expect(result.backupCodes).not.toEqual(PLAIN_CODES);
  });

  it('issues a new secret when no setup is pending', async () => {
    const update = makeUpdate();

    const result = await setupMFA({ user: noSetup, appName: 'Test App' }, { update });

    expect(result.secret).toMatch(/^[A-Z2-7]+$/);
    expect(result.secret).not.toBe(SECRET);
  });
});

describe('verifyMFASetup', () => {
  it('enables MFA on a valid TOTP code', async () => {
    const repo = makeRepo();
    const result = await verifyMFASetup(makePendingUser(), currentToken(), repo);
    expect(result.success).toBe(true);
    expect(repo.atomicEnableMfa).toHaveBeenCalledWith('user-1', SECRET);
  });

  it('rejects an invalid TOTP code without enabling MFA', async () => {
    await expect(verifyMFASetup(makePendingUser(), '000000', makeRepo())).rejects.toThrow(/Invalid/);
  });

  it('rejects an invalid code with MfaAttemptRejectedError carrying the reserved user', async () => {
    const repo = makeRepo();
    const error = await verifyMFASetup(makePendingUser(), '000000', repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.atomicEnableMfa).not.toHaveBeenCalled();
  });

  it('reserves the attempt before claiming the code', async () => {
    const repo = makeRepo();
    await verifyMFASetup(makePendingUser(), currentToken(), repo);
    expect(repo.atomicReserveMfaAttempt).toHaveBeenCalledWith('user-1');
    expect(repo.atomicReserveMfaAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      repo.atomicClaimTotpStep.mock.invocationCallOrder[0]
    );
  });

  it('throws MfaAttemptRejectedError with the locked user, and never claims or enables, when locked out', async () => {
    const repo = makeRepo({ reserved: false });
    const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(lockedUser);
    expect(repo.atomicClaimTotpStep).not.toHaveBeenCalled();
    expect(repo.atomicEnableMfa).not.toHaveBeenCalled();
  });

  it('rejects a replayed TOTP step with the reserved user as attemptState', async () => {
    const repo = makeRepo({ claimed: false });
    const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.atomicEnableMfa).not.toHaveBeenCalled();
  });

  it('claims the step of a previous-step token, not the current step', async () => {
    const nowMs = 1_700_000_000_000; // 20s into a 30s step, clear of the boundary
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const repo = makeRepo();
      const step = Math.floor(nowMs / 1000 / 30) - 1;
      const token = speakeasy.totp({ secret: SECRET, encoding: 'base32', time: Math.floor(nowMs / 1000) - 30 });
      await verifyMFASetup(makePendingUser(), token, repo);
      expect(repo.atomicClaimTotpStep).toHaveBeenCalledWith('user-1', step);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enables MFA by matching the verified secret, never rewriting the mfa subdocument', async () => {
    const repo = makeRepo();
    const user = { ...makePendingUser(), totpLastStep: 7 } as unknown as IUserDocument;
    await verifyMFASetup(user, currentToken(), repo);
    // The enable is conditional on the secret that was verified, so a concurrent setup that
    // replaced it cannot be switched on behind the user's back.
    expect(repo.atomicEnableMfa).toHaveBeenCalledWith('user-1', SECRET);
  });

  it('refuses to enable when a concurrent setup replaced the secret', async () => {
    const repo = makeRepo({ enabled: false });
    const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
  });

  describe('failures after the attempt was reserved', () => {
    it('wraps a rejecting enable, keeping the original error as cause', async () => {
      const repo = makeRepo();
      const cause = new Error('write failed');
      repo.atomicEnableMfa.mockRejectedValue(cause);
      const error = await verifyMFASetup(makePendingUser(), currentToken(), repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect((error as MfaAttemptRejectedError).cause).toBe(cause);
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
});
