import { describe, it, expect, beforeEach } from 'vitest';
import { MFA_ATTEMPT_RESET_WINDOW_MS, MFA_LOCKOUT_DURATION_MS, MFA_MAX_FAILED_ATTEMPTS } from '@bike4mind/common';
import { User, userRepository } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';

/**
 * Guards the atomic MFA attempt primitives: reserving an attempt BEFORE the code is compared
 * (so concurrent guesses cannot all slip past the lockout check) and claiming a TOTP time step
 * at most once (so a code cannot be replayed within its validity window).
 */
describe('atomic MFA attempt reservation and TOTP step claim', () => {
  setupMongoTest();

  const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
  let userId: string;

  const readMfa = async () => (await userRepository.findByIdWithMfaSecrets(userId))!.mfa!;
  const readTotpLastStep = async () => (await userRepository.findByIdWithMfaSecrets(userId))!.totpLastStep;

  beforeEach(async () => {
    await User.deleteMany({});
    const user = await User.create({
      username: 'mfa-atomic-user',
      email: 'mfa-atomic@example.com',
      name: 'MFA Atomic User',
      mfa: { totpEnabled: true, totpSecret: TOTP_SECRET, backupCodes: ['h1'], setupAt: new Date() },
    });
    userId = user.id;
  });

  describe('atomicReserveMfaAttempt', () => {
    it('increments failedAttempts on each reserve and locks when the limit is reached', async () => {
      for (let attempt = 1; attempt < MFA_MAX_FAILED_ATTEMPTS; attempt++) {
        const { reserved, user } = await userRepository.atomicReserveMfaAttempt(userId);
        expect(reserved).toBe(true);
        expect(user!.mfa!.failedAttempts).toBe(attempt);
        expect(user!.mfa!.lockedUntil ?? null).toBeNull();
      }

      const { reserved, user } = await userRepository.atomicReserveMfaAttempt(userId);
      expect(reserved).toBe(true);
      expect(user!.mfa!.failedAttempts).toBe(MFA_MAX_FAILED_ATTEMPTS);
      expect(new Date(user!.mfa!.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses with reserved:false while locked, returning the locked user without incrementing', async () => {
      for (let attempt = 0; attempt < MFA_MAX_FAILED_ATTEMPTS; attempt++) {
        await userRepository.atomicReserveMfaAttempt(userId);
      }

      const { reserved, user } = await userRepository.atomicReserveMfaAttempt(userId);
      expect(reserved).toBe(false);
      expect(user!.mfa!.failedAttempts).toBe(MFA_MAX_FAILED_ATTEMPTS);
      expect(new Date(user!.mfa!.lockedUntil!).getTime()).toBeGreaterThan(Date.now());
      expect((await readMfa()).failedAttempts).toBe(MFA_MAX_FAILED_ATTEMPTS);
    });

    it('lets exactly MFA_MAX_FAILED_ATTEMPTS of 10 concurrent reserves through', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => userRepository.atomicReserveMfaAttempt(userId))
      );

      expect(results.filter(result => result.reserved)).toHaveLength(MFA_MAX_FAILED_ATTEMPTS);
      expect(results.filter(result => !result.reserved)).toHaveLength(10 - MFA_MAX_FAILED_ATTEMPTS);
      expect((await readMfa()).failedAttempts).toBe(MFA_MAX_FAILED_ATTEMPTS);
    });

    it('re-locks on an attempt made after the lockout expired, while still inside the reset window', async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'mfa.failedAttempts': MFA_MAX_FAILED_ATTEMPTS,
            'mfa.lastFailedAttempt': new Date(Date.now() - MFA_LOCKOUT_DURATION_MS - 1000),
            'mfa.lockedUntil': new Date(Date.now() - 1000),
          },
        }
      );

      const { reserved, user } = await userRepository.atomicReserveMfaAttempt(userId);
      expect(reserved).toBe(true);
      // The last failure is inside the reset window, so the count continues rather than resetting:
      // the attempt pushes it past the max and the user is locked again.
      expect(user!.mfa!.failedAttempts).toBe(MFA_MAX_FAILED_ATTEMPTS + 1);
      expect(new Date(user!.mfa!.lockedUntil!).getTime()).toBeGreaterThan(Date.now());

      const next = await userRepository.atomicReserveMfaAttempt(userId);
      expect(next.reserved).toBe(false);
    });

    it('resets the count to 1 when the last failure is older than the reset window', async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'mfa.failedAttempts': MFA_MAX_FAILED_ATTEMPTS,
            'mfa.lastFailedAttempt': new Date(Date.now() - MFA_ATTEMPT_RESET_WINDOW_MS - 1000),
          },
        }
      );

      const { reserved, user } = await userRepository.atomicReserveMfaAttempt(userId);
      expect(reserved).toBe(true);
      expect(user!.mfa!.failedAttempts).toBe(1);
      expect(user!.mfa!.lockedUntil ?? null).toBeNull();
    });

    it('reports reserved:false with a null user for an unknown id', async () => {
      const { reserved, user } = await userRepository.atomicReserveMfaAttempt('64b000000000000000000000');
      expect(reserved).toBe(false);
      expect(user).toBeNull();
    });
  });

  describe('atomicClaimTotpStep', () => {
    it('claims a first step, then refuses the same or a lower step, then accepts a higher one', async () => {
      expect(await userRepository.atomicClaimTotpStep(userId, 100)).toBe(true);
      expect(await userRepository.atomicClaimTotpStep(userId, 100)).toBe(false);
      expect(await userRepository.atomicClaimTotpStep(userId, 99)).toBe(false);
      expect(await readTotpLastStep()).toBe(100);

      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(true);
      expect(await readTotpLastStep()).toBe(101);
    });

    it('lets exactly one of several concurrent claims of the same step win', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => userRepository.atomicClaimTotpStep(userId, 500))
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await readTotpLastStep()).toBe(500);
    });
  });

  describe('atomicConsumeBackupCode', () => {
    it('removes a stored code exactly once', async () => {
      expect(await userRepository.atomicConsumeBackupCode(userId, 'h1')).toBe(true);
      expect((await readMfa()).backupCodes).toEqual([]);
      expect(await userRepository.atomicConsumeBackupCode(userId, 'h1')).toBe(false);
    });

    it('does not remove a code that is not stored', async () => {
      expect(await userRepository.atomicConsumeBackupCode(userId, 'not-a-code')).toBe(false);
      expect((await readMfa()).backupCodes).toEqual(['h1']);
    });

    it('lets exactly one of several concurrent consumes of the same code win', async () => {
      await User.updateOne({ _id: userId }, { $set: { 'mfa.backupCodes': ['h1', 'h2'] } });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => userRepository.atomicConsumeBackupCode(userId, 'h1'))
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await readMfa()).backupCodes).toEqual(['h2']);
    });
  });

  describe('atomicEnableMfa', () => {
    // Setup leaves totpEnabled false until the issued secret is confirmed.
    const makePending = () => User.updateOne({ _id: userId }, { $set: { 'mfa.totpEnabled': false } });

    it('enables only while the stored secret still matches', async () => {
      await makePending();

      expect(await userRepository.atomicEnableMfa(userId, TOTP_SECRET)).not.toBeNull();
      expect((await readMfa()).totpEnabled).toBe(true);

      // Already enabled: the conditional enable no longer matches.
      expect(await userRepository.atomicEnableMfa(userId, TOTP_SECRET)).toBeNull();
    });

    it('refuses to enable a secret a concurrent setup replaced, leaving the new one pending', async () => {
      await makePending();
      // A second enrollment tab replaces the stored secret while the first tab still holds the old.
      await userRepository.update({
        id: userId,
        mfa: { totpSecret: 'REPLACEDSECRET', totpEnabled: false, backupCodes: ['h2'], setupAt: new Date() },
      });

      expect(await userRepository.atomicEnableMfa(userId, TOTP_SECRET)).toBeNull();

      const mfa = await readMfa();
      expect(mfa.totpEnabled).toBe(false);
      expect(mfa.totpSecret).toBe('REPLACEDSECRET');
    });

    it('preserves the select:false secrets while clearing the attempt/lockout fields', async () => {
      await makePending();
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'mfa.failedAttempts': 2,
            'mfa.lastFailedAttempt': new Date(),
            'mfa.lockedUntil': new Date(Date.now() + 60_000),
          },
        }
      );

      const enabled = await userRepository.atomicEnableMfa(userId, TOTP_SECRET);
      expect(enabled?.mfa?.lockedUntil ?? null).toBeNull();

      const mfa = await readMfa();
      expect(mfa.totpEnabled).toBe(true);
      expect(mfa.failedAttempts).toBe(0);
      expect(mfa.lastFailedAttempt ?? null).toBeNull();
      expect(mfa.totpSecret).toBe(TOTP_SECRET);
      expect(mfa.backupCodes).toEqual(['h1']);
    });
  });

  describe('field-level success write', () => {
    it('clears the attempt/lockout fields without touching the secrets or backup codes', async () => {
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            'mfa.failedAttempts': 2,
            'mfa.lastFailedAttempt': new Date(),
            'mfa.lockedUntil': new Date(Date.now() + 60_000),
          },
        }
      );

      await userRepository.update(
        { id: userId, 'mfa.failedAttempts': 0, 'mfa.lastUsedAt': new Date() },
        { unset: ['mfa.lastFailedAttempt', 'mfa.lockedUntil'] }
      );

      const mfa = await readMfa();
      expect(mfa.failedAttempts).toBe(0);
      expect(mfa.lockedUntil ?? null).toBeNull();
      expect(mfa.lastFailedAttempt ?? null).toBeNull();
      // The select:false secrets and the stored backup set survive, because the write never
      // rebuilds the `mfa` subdocument.
      expect(mfa.totpEnabled).toBe(true);
      expect(mfa.totpSecret).toBe(TOTP_SECRET);
      expect(mfa.backupCodes).toEqual(['h1']);
    });
  });

  describe('totpLastStep isolation from the mfa subdocument', () => {
    it('is not rolled back by a whole-mfa update built from a snapshot taken before the claim', async () => {
      const snapshot = (await userRepository.findByIdWithMfaSecrets(userId))!;
      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(true);

      await userRepository.update({ id: userId, mfa: { ...snapshot.mfa!, failedAttempts: 0 } });

      expect(await readTotpLastStep()).toBe(101);
      expect((await readMfa()).totpSecret).toBe(TOTP_SECRET);
      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(false);
    });

    it('lets the same step be claimed again once the counter is cleared for a new secret', async () => {
      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(true);
      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(false);

      // What a re-enrollment writes before issuing a fresh secret.
      await userRepository.update({ id: userId, totpLastStep: null });

      expect(await readTotpLastStep()).toBeNull();
      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(true);
    });
  });
});
