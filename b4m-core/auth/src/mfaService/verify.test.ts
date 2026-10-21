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

// update echoes back the merged user so verifyMFA can return it. Reserve/claim/consume default to success.
const makeRepo = (overrides: { reserved?: boolean; claimed?: boolean; consumed?: boolean } = {}) => {
  const { reserved = true, claimed = true, consumed = true } = overrides;
  return {
    update: vi.fn(async (u: unknown) => u as IUserDocument),
    atomicReserveMfaAttempt: vi.fn(async () => ({ reserved, user: reserved ? reservedUser : lockedUser })),
    atomicClaimTotpStep: vi.fn(async () => claimed),
    atomicConsumeBackupCode: vi.fn(async () => consumed),
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

  it('accepts a backup code (case-insensitive), consumes it atomically, and never rewrites the stored set', async () => {
    const repo = makeRepo({ claimed: false });
    const result = await verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo);
    expect(result.verified).toBe(true);
    expect(result.usedBackupCode).toBe(hashBackupCode('ABCDE12345'));
    expect(repo.atomicConsumeBackupCode).toHaveBeenCalledWith('user-1', hashBackupCode('ABCDE12345'));
    // The success write must not carry the backup set: rebuilding it from this pre-reservation
    // snapshot would restore a code a concurrent request just consumed.
    const data = repo.update.mock.calls[0][0] as Record<string, unknown>;
    expect(data).not.toHaveProperty('mfa');
  });

  it('rejects a backup code that a concurrent request already consumed', async () => {
    const repo = makeRepo({ claimed: false, consumed: false });
    const error = await verifyMFA({ user: makeUser(), token: 'abcde12345' }, repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MfaAttemptRejectedError);
    expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('claims the step of a previous-step token, not the current step', async () => {
    const nowMs = 1_700_000_000_000; // 20s into a 30s step, clear of the boundary
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    try {
      const repo = makeRepo();
      const step = Math.floor(nowMs / 1000 / 30) - 1;
      const token = speakeasy.totp({ secret: SECRET, encoding: 'base32', time: Math.floor(nowMs / 1000) - 30 });
      await verifyMFA({ user: makeUser(), token }, repo);
      expect(repo.atomicClaimTotpStep).toHaveBeenCalledWith('user-1', step);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['TOTP', () => currentToken()],
    ['backup code', () => 'abcde12345'],
  ])(
    'never writes a replay step in the %s success update, even when the user has totpLastStep',
    async (_label, token) => {
      const repo = makeRepo();
      const user = { ...makeUser(), totpLastStep: 7 } as unknown as IUserDocument;
      await verifyMFA({ user, token: token() }, repo);
      const data = repo.update.mock.calls[0][0] as Record<string, unknown>;
      expect(data).not.toHaveProperty('totpLastStep');
      expect(data).not.toHaveProperty('mfa');
    }
  );

  describe('failures after the attempt was reserved', () => {
    const expectRejectedWithCause = async (repo: ReturnType<typeof makeRepo>, cause: unknown) => {
      const error = await verifyMFA({ user: makeUser(), token: currentToken() }, repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect((error as MfaAttemptRejectedError).cause).toBe(cause);
    };

    it('wraps a rejecting update', async () => {
      const repo = makeRepo();
      const cause = new Error('write failed');
      repo.update.mockRejectedValue(cause);
      await expectRejectedWithCause(repo, cause);
    });

    it('wraps an update that returns null', async () => {
      const repo = makeRepo();
      repo.update.mockResolvedValue(null as never);
      const error = await verifyMFA({ user: makeUser(), token: currentToken() }, repo).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MfaAttemptRejectedError);
      expect((error as MfaAttemptRejectedError).attemptState).toBe(reservedUser);
      expect(((error as MfaAttemptRejectedError).cause as Error).message).toMatch(/Failed to update/);
    });

    it('wraps a rejecting claim', async () => {
      const repo = makeRepo();
      const cause = new Error('claim failed');
      repo.atomicClaimTotpStep.mockRejectedValue(cause);
      await expectRejectedWithCause(repo, cause);
    });
  });

  it('throws when MFA is not enabled for the user', async () => {
    await expect(
      verifyMFA({ user: makeUser({ totpEnabled: false }), token: currentToken() }, makeRepo())
    ).rejects.toThrow(/not enabled/);
  });

  // Regression: the select:false MFA-secret hardening bricked MFA because the endpoints
  // cleared failed attempts in a SEPARATE update built from verifyMFA's (not-+selected)
  // return value, wiping totpSecret/backupCodes via `$set: { mfa }`. The clear is now a
  // field-level write that never touches the `mfa` subdocument at all.
  it('clears failed-attempt/lockout state with a field-level write that cannot wipe the secrets', async () => {
    const repo = makeRepo();
    const user = makeUser({
      failedAttempts: 2,
      lastFailedAttempt: new Date(),
      lockedUntil: new Date(Date.now() + 1000),
    });
    await verifyMFA({ user, token: currentToken() }, repo);
    const [data, options] = repo.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { unset?: string[] },
    ];
    // Only the attempt/lockout fields are written - there is no whole-`mfa` `$set` that could
    // rebuild (and so wipe) the select:false secrets or the stored backup set.
    expect(data).not.toHaveProperty('mfa');
    expect(data['mfa.failedAttempts']).toBe(0);
    expect(data['mfa.lastUsedAt']).toBeInstanceOf(Date);
    expect(options?.unset).toEqual(expect.arrayContaining(['mfa.lastFailedAttempt', 'mfa.lockedUntil']));
  });
});
