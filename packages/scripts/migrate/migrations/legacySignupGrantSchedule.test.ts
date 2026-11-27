import { describe, it, expect } from 'vitest';
import {
  isStoredToggleOn,
  signupGrantScheduleFromValues,
  storedGrantCredits,
  type LegacySignupGrantCreditKey,
} from './legacySignupGrantSchedule';

const reader = (values: Partial<Record<LegacySignupGrantCreditKey, number>>) => (key: LegacySignupGrantCreditKey) =>
  values[key];

describe('legacy signupGrantScheduleFromValues', () => {
  it('pays the flat grant from defaultFreeCredits with staging off', () => {
    const schedule = signupGrantScheduleFromValues(
      reader({ defaultFreeCredits: 500, signupGrantCredits: 300, signupGrantActivityDailyCredits: 100 }),
      { staged: false, activity: false }
    );
    expect(schedule).toEqual({
      initialCredits: 500,
      dailyCredits: 0,
      dripCap: 0,
      unlockCredits: 0,
      paysFlat: true,
      inviteBonusCredits: 0,
      dripCapSource: 'legacy',
    });
  });

  it('splits drip and unlock when the activity max is below verifiedUnlockCredits', () => {
    const schedule = signupGrantScheduleFromValues(
      reader({
        defaultFreeCredits: 500,
        signupGrantCredits: 300,
        signupGrantActivityDailyCredits: 100,
        signupGrantActivityMaxCredits: 2000,
        verifiedUnlockCredits: 5000,
      }),
      { staged: true, activity: true }
    );
    expect(schedule).toEqual({
      initialCredits: 300,
      dailyCredits: 100,
      dripCap: 2000,
      unlockCredits: 5000,
      paysFlat: false,
      inviteBonusCredits: 0,
      dripCapSource: 'legacy',
    });
  });

  it('ignores the activity daily amount with the activity toggle off and defaults an unset activity max to 9000', () => {
    const schedule = signupGrantScheduleFromValues(
      reader({ signupGrantActivityDailyCredits: 100, verifiedUnlockCredits: 1500 }),
      { staged: true, activity: false }
    );
    expect(schedule).toEqual({
      initialCredits: 0,
      dailyCredits: 0,
      dripCap: 1500,
      unlockCredits: 1500,
      paysFlat: false,
      inviteBonusCredits: 0,
      dripCapSource: 'default',
    });
  });

  it('caps the drip at 0 when staged with nothing stored (verifiedUnlockCredits defaults to 0)', () => {
    expect(signupGrantScheduleFromValues(reader({}), { staged: true, activity: true })).toEqual({
      initialCredits: 0,
      dailyCredits: 0,
      dripCap: 0,
      unlockCredits: 0,
      paysFlat: false,
      inviteBonusCredits: 0,
      dripCapSource: 'default',
    });
  });

  it('lets stored schedule keys win over the toggles and legacy keys', () => {
    const schedule = signupGrantScheduleFromValues(
      reader({
        signupGrantInitialCredits: 200,
        signupGrantDailyCredits: 50,
        signupGrantDripCap: 3000,
        signupGrantInviteBonusCredits: 10,
        defaultFreeCredits: 500,
        verifiedUnlockCredits: 5000,
      }),
      { staged: false, activity: false }
    );
    expect(schedule).toEqual({
      initialCredits: 200,
      dailyCredits: 50,
      dripCap: 3000,
      unlockCredits: 3000,
      paysFlat: false,
      inviteBonusCredits: 10,
      dripCapSource: 'setting',
    });
  });
});

describe('legacy storedGrantCredits', () => {
  it.each([
    ['0', 0],
    [7, 7],
    ['1200', 1200],
    ['', undefined],
    ['  ', undefined],
    [null, undefined],
    [undefined, undefined],
    ['12.5', undefined],
    ['-1', undefined],
    ['abc', undefined],
    [true, undefined],
  ])('reads %j as %j', (value, expected) => {
    expect(storedGrantCredits('signupGrantDripCap', value)).toBe(expected);
  });

  it.each([
    ['signupGrantActivityDailyCredits', '10000', 10000],
    ['signupGrantActivityDailyCredits', '10001', undefined],
    ['signupGrantActivityMaxCredits', 1000000, 1000000],
    ['signupGrantActivityMaxCredits', '1000001', undefined],
    ['verifiedUnlockCredits', '2000000', 2000000],
  ] as const)('reads %s %j against its registry max as %j', (key, value, expected) => {
    expect(storedGrantCredits(key, value)).toBe(expected);
  });
});

describe('legacy isStoredToggleOn', () => {
  it.each([
    [true, true],
    ['true', true],
    ['false', false],
    [1, false],
    [undefined, false],
  ])('reads %j as %j', (value, expected) => {
    expect(isStoredToggleOn(value)).toBe(expected);
  });
});
