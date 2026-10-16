import { describe, it, expect } from 'vitest';
import speakeasy from 'speakeasy';
import { clearFailedAttempts, matchTOTPStep, userHasMFAConfigured } from './utils';
import type { IMFAConfig, IUserDocument } from '@bike4mind/common';

const user = (mfa: unknown) => ({ mfa }) as unknown as IUserDocument;

describe('userHasMFAConfigured', () => {
  // Regression guard: totpSecret is select:false and is NOT loaded on the OTC login
  // path (findByEmail). MFA detection MUST rely on totpEnabled alone - re-adding a
  // `&& user.mfa.totpSecret` requirement here would make MFA-enabled users silently
  // bypass MFA when logging in via OTC.
  it('is true when totpEnabled, even without the (select:false) totpSecret loaded', () => {
    expect(userHasMFAConfigured(user({ totpEnabled: true }))).toBe(true);
  });

  it('is false when MFA is not enabled', () => {
    expect(userHasMFAConfigured(user({ totpEnabled: false }))).toBe(false);
    expect(userHasMFAConfigured(user(null))).toBe(false);
    expect(userHasMFAConfigured(user(undefined))).toBe(false);
  });
});

describe('clearFailedAttempts', () => {
  it('resets lockout state and preserves secrets', () => {
    const mfa = {
      totpEnabled: true,
      totpSecret: 'SECRET',
      backupCodes: ['h1', 'h2'],
      failedAttempts: 3,
      lastFailedAttempt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
    } as unknown as IMFAConfig;

    const result = clearFailedAttempts(mfa);

    expect(result.failedAttempts).toBe(0);
    expect(result.lastFailedAttempt).toBeUndefined();
    expect(result.lockedUntil).toBeUndefined();
    expect(result.totpSecret).toBe('SECRET');
    expect(result.backupCodes).toEqual(['h1', 'h2']);
    expect(mfa.failedAttempts).toBe(3);
  });
});

describe('matchTOTPStep', () => {
  const secret = speakeasy.generateSecret().base32;
  // Mid-step instant so +/-1 second never crosses a step boundary.
  const nowMs = 1_700_000_015_000;
  const currentStep = Math.floor(nowMs / 1000 / 30);
  const codeAt = (offsetSeconds: number) =>
    speakeasy.totp({ secret, encoding: 'base32', time: Math.floor(nowMs / 1000) + offsetSeconds });

  it('returns the current step for a fresh code', () => {
    expect(matchTOTPStep(secret, codeAt(0), 1, nowMs)).toBe(currentStep);
  });

  it('returns the previous step for a code from 30s ago', () => {
    expect(matchTOTPStep(secret, codeAt(-30), 1, nowMs)).toBe(currentStep - 1);
  });

  it('returns the next step for a code 30s ahead (clock drift)', () => {
    expect(matchTOTPStep(secret, codeAt(30), 1, nowMs)).toBe(currentStep + 1);
  });

  it('returns null for a wrong code', () => {
    const wrong = codeAt(0) === '000000' ? '000001' : '000000';
    expect(matchTOTPStep(secret, wrong, 1, nowMs)).toBeNull();
  });

  it('returns null for a code 2 steps old', () => {
    expect(matchTOTPStep(secret, codeAt(-60), 1, nowMs)).toBeNull();
  });
});
