import { describe, it, expect, beforeEach } from 'vitest';
import { MFA_LOCKOUT_DURATION_MS, MFA_MAX_FAILED_ATTEMPTS } from '@bike4mind/common';
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

    it('allows reserving again once the lockout has expired', async () => {
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
      expect(user!.mfa!.failedAttempts).toBeGreaterThan(0);
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
      expect((await readMfa()).lastTotpStep).toBe(100);

      expect(await userRepository.atomicClaimTotpStep(userId, 101)).toBe(true);
      expect((await readMfa()).lastTotpStep).toBe(101);
    });

    it('lets exactly one of several concurrent claims of the same step win', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => userRepository.atomicClaimTotpStep(userId, 500))
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await readMfa()).lastTotpStep).toBe(500);
    });
  });

  describe('lastTotpStep schema field', () => {
    it('persists through a whole-mfa update carrying totpSecret (not stripped by the schema)', async () => {
      const current = (await userRepository.findByIdWithMfaSecrets(userId))!;
      await userRepository.update({ id: userId, mfa: { ...current.mfa!, lastTotpStep: 4242 } });

      const after = await readMfa();
      expect(after.lastTotpStep).toBe(4242);
      expect(after.totpSecret).toBe(TOTP_SECRET);
    });
  });
});
