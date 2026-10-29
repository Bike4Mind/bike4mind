import { describe, expect, it } from 'vitest';
import {
  LARGE_SIGNUP_GRANT_CREDITS,
  SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE,
  findUnsetSignupProtections,
  largestSignupGrant,
  newSignupGrant,
  raisesGrantAboveLimit,
  signupGrantPathTotal,
  resolveSignupGrantSettings,
} from './signupGrant';

const settings = (values: Record<string, unknown>) =>
  ({
    findBySettingName: async (name: string) => (name in values ? { settingValue: values[name] } : null),
  }) as unknown as Parameters<typeof newSignupGrant>[0];

describe('signup grant configuration', () => {
  it('does not enroll accounts unless explicitly enabled', async () => {
    expect(await newSignupGrant(settings({ defaultFreeCredits: '75' }))).toBeUndefined();
  });

  it.each(['0', '75', '-1', 'invalid'])(
    'preserves a restricted legacy setting %s without adding an unlock',
    async value => {
      const result = await resolveSignupGrantSettings(settings({ defaultFreeCredits: value }));
      expect(result.signupCredits).toBe(value === '75' ? 75 : 0);
      expect(result.unlockCredits).toBe(0);
    }
  );

  it('honors explicit zero instead of falling back to the legacy grant', async () => {
    const result = await newSignupGrant(
      settings({
        stagedSignupGrantEnabled: 'true',
        defaultFreeCredits: '75',
        signupGrantCredits: '0',
        verifiedUnlockCredits: '25',
      })
    );
    expect(result).toEqual({
      stage: 'pending_email',
      signupCredits: 0,
      unlockCredits: 25,
      creditsReleased: 0,
      nextCondition: 'email_verification',
    });
  });
});

describe('signup grant protections', () => {
  const allOn = {
    signupGrantRiskPolicy: { enabled: true },
    maxSignupsPerIpPerDay: 5,
    maxSignupsPerAsnPerHour: '20',
    signupBurstAutoHold: 'true',
  };

  it('reports every protection at its off default', () => {
    expect(findUnsetSignupProtections({})).toEqual([
      'signupGrantRiskPolicy',
      'maxSignupsPerIpPerDay',
      'maxSignupsPerAsnPerHour',
      'signupBurstAutoHold',
    ]);
    expect(findUnsetSignupProtections({ signupGrantRiskPolicy: { enabled: false }, maxSignupsPerIpPerDay: 0 })).toEqual(
      ['signupGrantRiskPolicy', 'maxSignupsPerIpPerDay', 'maxSignupsPerAsnPerHour', 'signupBurstAutoHold']
    );
  });

  it('accepts boolean and string forms of an enabled protection', () => {
    expect(findUnsetSignupProtections(allOn)).toEqual([]);
    expect(findUnsetSignupProtections({ ...allOn, signupBurstAutoHold: true })).toEqual([]);
  });

  it('reads the policy stored as a JSON string, as the seed migration writes it', () => {
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: '{"enabled":true}' })).toEqual([]);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: '{"enabled":false}' })).toEqual([
      'signupGrantRiskPolicy',
    ]);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: 'not json' })).toEqual([
      'signupGrantRiskPolicy',
    ]);
  });

  it('reports only the protections still off', () => {
    expect(findUnsetSignupProtections({ ...allOn, maxSignupsPerAsnPerHour: 0 })).toEqual(['maxSignupsPerAsnPerHour']);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: 'on' })).toEqual(['signupGrantRiskPolicy']);
  });

  it('takes the larger of the flat grant and the staged total', () => {
    expect(largestSignupGrant({ defaultFreeCredits: 80 })).toBe(80);
    expect(largestSignupGrant({ defaultFreeCredits: 10, signupGrantCredits: '60', verifiedUnlockCredits: '70' })).toBe(
      130
    );
    expect(largestSignupGrant({ defaultFreeCredits: 'junk', signupGrantCredits: -5 })).toBe(0);
  });

  it('counts fractional and oversized flat grants the schema accepts', () => {
    expect(largestSignupGrant({ defaultFreeCredits: 150.5 })).toBe(150.5);
    expect(largestSignupGrant({ defaultFreeCredits: '150.5' })).toBe(150.5);
    expect(largestSignupGrant({ defaultFreeCredits: 1e21 })).toBe(1e21);
    expect(largestSignupGrant({ defaultFreeCredits: '   ' })).toBe(0);
  });

  it('totals each grant path separately', () => {
    const values = { defaultFreeCredits: 0, signupGrantCredits: 500, verifiedUnlockCredits: 10 };
    expect(signupGrantPathTotal('defaultFreeCredits', values)).toBe(0);
    expect(signupGrantPathTotal('signupGrantCredits', values)).toBe(510);
    expect(signupGrantPathTotal('verifiedUnlockCredits', values)).toBe(510);
  });

  it('keeps the log message the infra alarm filter matches', () => {
    expect(SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE).toBe('signup-grant-protections-off');
  });

  it('refuses only a raise above the limit, never a hold or a reduction', () => {
    expect(raisesGrantAboveLimit(0, LARGE_SIGNUP_GRANT_CREDITS)).toBe(false);
    expect(raisesGrantAboveLimit(0, LARGE_SIGNUP_GRANT_CREDITS + 1)).toBe(true);
    expect(raisesGrantAboveLimit(500, 500)).toBe(false);
    expect(raisesGrantAboveLimit(500, 200)).toBe(false);
    expect(raisesGrantAboveLimit(500, 501)).toBe(true);
  });
});
