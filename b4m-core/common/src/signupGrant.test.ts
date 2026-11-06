import { describe, expect, it } from 'vitest';
import {
  newSignupGrant,
  resolveSignupGrantSchedule,
  resolveSignupGrantSettings,
  signupGrantDripOpen,
  signupGrantDripRemaining,
} from './signupGrant';

const settings = (values: Record<string, unknown>) =>
  ({
    findBySettingName: async (name: string) => (name in values ? { settingValue: values[name] } : null),
  }) as unknown as Parameters<typeof newSignupGrant>[0];

describe('signup grant configuration', () => {
  it('locks nothing and pays an invite whole when the drip cap is 0', async () => {
    const offEnv = { signupGrantInitialCredits: '75', signupGrantDripCap: '0' };
    expect(await newSignupGrant(settings(offEnv))).toMatchObject({ signupCredits: 75, unlockCredits: 0 });
    expect(await newSignupGrant(settings(offEnv), 60)).toMatchObject({ signupCredits: 60, unlockCredits: 0 });
  });

  it('pays an invite worth more than the initial credits whole under a stored drip cap of 0', async () => {
    const offEnv = { signupGrantInitialCredits: '75', signupGrantDailyCredits: '0', signupGrantDripCap: '0' };
    expect(await newSignupGrant(settings(offEnv), 200)).toMatchObject({ signupCredits: 200, unlockCredits: 0 });
  });

  it.each([
    ['a stored drip cap', { signupGrantInitialCredits: '75', signupGrantDripCap: '9000' }],
    ['no cap key', { signupGrantInitialCredits: '75' }],
  ])('still splits an invite into tranche plus locked remainder under %s', async (_label, values) => {
    expect(await newSignupGrant(settings(values), 200)).toMatchObject({ signupCredits: 75, unlockCredits: 125 });
  });

  it('honors an explicit zero initial grant', async () => {
    const result = await newSignupGrant(settings({ signupGrantInitialCredits: '0', signupGrantDripCap: '25' }));
    expect(result).toEqual({
      stage: 'pending_email',
      signupCredits: 0,
      unlockCredits: 25,
      creditsReleased: 0,
      nextCondition: 'email_verification',
    });
  });
});

describe('signup grant schedule', () => {
  const emptySchedule = {
    initialCredits: 0,
    dailyCredits: 0,
    dripCap: 9000,
    unlockCredits: 9000,
    paysFlat: false,
    inviteBonusCredits: 0,
    dripCapSource: 'default',
  };

  it('resolves the four schedule keys', async () => {
    const schedule = await resolveSignupGrantSchedule(
      settings({
        signupGrantInitialCredits: '250',
        signupGrantDailyCredits: 300,
        signupGrantDripCap: '4000',
        signupGrantInviteBonusCredits: '50',
      })
    );
    expect(schedule).toEqual({
      initialCredits: 250,
      dailyCredits: 300,
      dripCap: 4000,
      unlockCredits: 4000,
      paysFlat: false,
      inviteBonusCredits: 50,
      dripCapSource: 'setting',
    });
  });

  it('falls back to 0 and the registry drip cap default when nothing is stored', async () => {
    expect(await resolveSignupGrantSchedule(settings({}))).toEqual(emptySchedule);
    const config = await resolveSignupGrantSettings(settings({}));
    expect([config.signupCredits, config.unlockCredits]).toEqual([0, 9000]);
  });

  it('never reads the retired keys', async () => {
    const retired = {
      stagedSignupGrantEnabled: 'false',
      signupGrantActivityEnabled: 'true',
      defaultFreeCredits: '10000',
      signupGrantCredits: '1000',
      verifiedUnlockCredits: '3000',
      signupGrantActivityDailyCredits: '1000',
      signupGrantActivityMaxCredits: '2000',
    };
    expect(await resolveSignupGrantSchedule(settings(retired))).toEqual(emptySchedule);
  });

  it('honours a stored 0 but treats an absent key as unset', async () => {
    const zero = await resolveSignupGrantSchedule(
      settings({ signupGrantInitialCredits: '0', signupGrantDailyCredits: '0', signupGrantDripCap: 0 })
    );
    expect(zero).toMatchObject({ initialCredits: 0, dailyCredits: 0, dripCap: 0, unlockCredits: 0, paysFlat: true });
    expect(zero.dripCapSource).toBe('setting');
  });

  it.each(['', '  ', 'garbage', '-5', '1.5', null])('falls back past an invalid stored value %j', async value => {
    const schedule = await resolveSignupGrantSchedule(
      settings({
        signupGrantInitialCredits: value,
        signupGrantDailyCredits: value,
        signupGrantDripCap: value,
        signupGrantInviteBonusCredits: value,
      })
    );
    expect(schedule).toEqual(emptySchedule);
  });

  it('reads all four keys in one batched call when the repository offers it', async () => {
    const findBySettingNames = async (names: string[]) =>
      names.includes('signupGrantDripCap') ? [{ settingName: 'signupGrantDripCap', settingValue: '12000' }] : [];
    const reader = { findBySettingName: async () => null, findBySettingNames } as unknown as Parameters<
      typeof resolveSignupGrantSchedule
    >[0];
    expect(await resolveSignupGrantSchedule(reader)).toMatchObject({
      dripCap: 12000,
      unlockCredits: 12000,
      dripCapSource: 'setting',
    });
  });
});

describe('signupGrantDripRemaining', () => {
  it.each([
    [undefined, 9000],
    [NaN, 9000],
    [-500, 9000],
    [1.5, 9000],
    [2000, 7000],
    [9000, 0],
    [9500, 0],
  ])('dripped %s under a 9000 cap leaves %s', (dripCredits, remaining) => {
    expect(signupGrantDripRemaining({ dripCredits }, 9000)).toBe(remaining);
  });
  it('leaves nothing under a 0 cap', () => {
    expect(signupGrantDripRemaining({}, 0)).toBe(0);
  });
});

describe('signupGrantDripOpen', () => {
  it.each([
    [{ stage: 'signup' }, true],
    [{ stage: 'unlocked', unlockedBy: 'activity_drip' }, true],
    [{ stage: 'unlocked', unlockedBy: 'card_verified' }, false],
    [{ stage: 'unlocked' }, false],
    [{ stage: 'pending_email' }, false],
    [{ stage: 'signup', unlockForfeited: { cause: 'refund', at: new Date(0) } }, false],
  ] as const)('%j is open: %s', (grant, open) => {
    expect(signupGrantDripOpen(grant)).toBe(open);
  });
});
