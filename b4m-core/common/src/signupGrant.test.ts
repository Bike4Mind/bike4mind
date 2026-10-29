import { describe, expect, it } from 'vitest';
import {
  LARGE_SIGNUP_GRANT_CREDITS,
  SIGNUP_GRANT_UNPROTECTED_LOG_MESSAGE,
  findUnsetSignupProtections,
  largestSignupGrant,
  newSignupGrant,
  raisesGrantAboveLimit,
  signupGrantPathTotal,
  signupGrantWriteGap,
  resolveSignupGrantSettings,
} from './signupGrant';

const VALID_POLICY = {
  enabled: true,
  version: 'v1',
  rules: [
    { signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 2, missing: 'score', missingWeight: 0 },
    { signal: 'ipSignups', comparison: 'gte', threshold: 3, weight: 2, missing: 'score', missingWeight: 0 },
  ],
  reducedAt: 3,
  reviewAt: 6,
  reducedFraction: 0.5,
};

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
    signupGrantRiskPolicy: VALID_POLICY,
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
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: JSON.stringify(VALID_POLICY) })).toEqual([]);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: '{"enabled":false}' })).toEqual([
      'signupGrantRiskPolicy',
    ]);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: 'not json' })).toEqual([
      'signupGrantRiskPolicy',
    ]);
  });

  it('does not treat a bare or incomplete enabled policy as protection, since the runtime ignores it', () => {
    const unset = ['signupGrantRiskPolicy'];
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: { enabled: true } })).toEqual(unset);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: '{"enabled":true}' })).toEqual(unset);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: { ...VALID_POLICY, rules: [] } })).toEqual(unset);
    expect(
      findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: { ...VALID_POLICY, reviewAt: 1, reducedAt: 3 } })
    ).toEqual(unset);
  });

  it('does not treat a non-boolean enabled value as protection', () => {
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: { enabled: 'true' } })).toEqual([
      'signupGrantRiskPolicy',
    ]);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: '{"enabled":"true"}' })).toEqual([
      'signupGrantRiskPolicy',
    ]);
  });

  it('reports only the protections still off', () => {
    expect(findUnsetSignupProtections({ ...allOn, maxSignupsPerAsnPerHour: 0 })).toEqual(['maxSignupsPerAsnPerHour']);
    expect(findUnsetSignupProtections({ ...allOn, signupGrantRiskPolicy: 'on' })).toEqual(['signupGrantRiskPolicy']);
  });

  it('takes the larger of the flat grant and the staged total', () => {
    expect(largestSignupGrant({ defaultFreeCredits: 80 })).toBe(80);
    expect(
      largestSignupGrant({
        stagedSignupGrantEnabled: 'true',
        defaultFreeCredits: 10,
        signupGrantCredits: '60',
        verifiedUnlockCredits: '70',
      })
    ).toBe(130);
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

  it('ignores the staged total while staging is disabled', () => {
    const values = { defaultFreeCredits: 50, signupGrantCredits: 500 };
    expect(largestSignupGrant(values)).toBe(50);
    expect(largestSignupGrant({ ...values, stagedSignupGrantEnabled: false })).toBe(50);
    expect(largestSignupGrant({ ...values, stagedSignupGrantEnabled: true })).toBe(500);
  });

  it('falls back to the flat grant when the staged signup row is missing', () => {
    expect(signupGrantPathTotal('signupGrantCredits', { defaultFreeCredits: 90, verifiedUnlockCredits: 20 })).toBe(110);
    expect(signupGrantPathTotal('signupGrantCredits', { defaultFreeCredits: 90, signupGrantCredits: 0 })).toBe(0);
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

describe('signupGrantWriteGap', () => {
  const allOn = {
    signupGrantRiskPolicy: VALID_POLICY,
    maxSignupsPerIpPerDay: 5,
    maxSignupsPerAsnPerHour: 20,
    signupBurstAutoHold: true,
  };
  const LARGE = LARGE_SIGNUP_GRANT_CREDITS + 1;

  it('refuses raising a grant path above the limit, the dormant staged path included', () => {
    expect(signupGrantWriteGap({}, { defaultFreeCredits: LARGE })).toContain('signupGrantRiskPolicy');
    expect(signupGrantWriteGap({}, { signupGrantCredits: LARGE })).toContain('signupGrantRiskPolicy');
    expect(signupGrantWriteGap({}, { defaultFreeCredits: LARGE_SIGNUP_GRANT_CREDITS })).toBeNull();
  });

  it('allows any change once every protection is on', () => {
    expect(signupGrantWriteGap(allOn, { ...allOn, defaultFreeCredits: 5000 })).toBeNull();
  });

  it('refuses turning a protection off while a large grant is live', () => {
    const before = { ...allOn, defaultFreeCredits: 500 };
    expect(signupGrantWriteGap(before, { ...before, maxSignupsPerIpPerDay: 0 })).toEqual(['maxSignupsPerIpPerDay']);
    expect(signupGrantWriteGap(before, { ...before, signupBurstAutoHold: false })).toEqual(['signupBurstAutoHold']);
  });

  it('allows turning a protection off while every live grant is at or under the limit', () => {
    const before = { ...allOn, defaultFreeCredits: 50, signupGrantCredits: 500 };
    expect(signupGrantWriteGap(before, { ...before, maxSignupsPerIpPerDay: 0 })).toBeNull();
  });

  it('refuses enabling staging over a staged total above the limit', () => {
    const before = { defaultFreeCredits: 50, signupGrantCredits: 500, stagedSignupGrantEnabled: false };
    expect(signupGrantWriteGap(before, { ...before, stagedSignupGrantEnabled: true })).not.toBeNull();
    const small = { ...before, signupGrantCredits: 50 };
    expect(signupGrantWriteGap(small, { ...small, stagedSignupGrantEnabled: true })).toBeNull();
  });

  it('allows lowering an over-limit grant while protections are off', () => {
    expect(signupGrantWriteGap({ defaultFreeCredits: 500 }, { defaultFreeCredits: LARGE })).toBeNull();
  });
});
