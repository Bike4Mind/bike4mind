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
  it('enrolls with the retired staged flag off, locking nothing when the drip cap is 0', async () => {
    const offEnv = { stagedSignupGrantEnabled: 'false', defaultFreeCredits: '75', signupGrantDripCap: '0' };
    expect(await newSignupGrant(settings(offEnv))).toMatchObject({ signupCredits: 75, unlockCredits: 0 });
    expect(await newSignupGrant(settings(offEnv), 60)).toMatchObject({ signupCredits: 60, unlockCredits: 0 });
  });

  it('pays an invite worth more than the initial credits whole under a stored drip cap of 0', async () => {
    const offEnv = { signupGrantInitialCredits: '75', signupGrantDailyCredits: '0', signupGrantDripCap: '0' };
    expect(await newSignupGrant(settings(offEnv), 200)).toMatchObject({ signupCredits: 200, unlockCredits: 0 });
  });

  it.each([
    ['a stored drip cap', { signupGrantInitialCredits: '75', signupGrantDripCap: '9000' }],
    [
      'a legacy unlock key of 0',
      { stagedSignupGrantEnabled: 'true', signupGrantCredits: '75', verifiedUnlockCredits: '0' },
    ],
    ['no cap key', { stagedSignupGrantEnabled: 'true', signupGrantCredits: '75' }],
  ])('still splits an invite into tranche plus locked remainder under %s', async (_label, values) => {
    expect(await newSignupGrant(settings(values), 200)).toMatchObject({ signupCredits: 75, unlockCredits: 125 });
  });

  it.each(['0', '75', '-1', 'invalid'])(
    'preserves a restricted legacy setting %s and falls back to the default drip cap',
    async value => {
      const result = await resolveSignupGrantSettings(
        settings({ stagedSignupGrantEnabled: 'true', defaultFreeCredits: value })
      );
      expect(result.signupCredits).toBe(value === '75' ? 75 : 0);
      expect(result.unlockCredits).toBe(9000);
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

describe('signup grant schedule', () => {
  const prodOldKeys = {
    stagedSignupGrantEnabled: 'true',
    signupGrantActivityEnabled: 'true',
    defaultFreeCredits: '10000',
    signupGrantCredits: '1000',
    verifiedUnlockCredits: '9000',
    signupGrantActivityDailyCredits: '1000',
    signupGrantActivityMaxCredits: '9000',
  };

  it('resolves only-old-keys to the same schedule as before', async () => {
    expect(await resolveSignupGrantSchedule(settings(prodOldKeys))).toEqual({
      initialCredits: 1000,
      dailyCredits: 1000,
      dripCap: 9000,
      unlockCredits: 9000,
      paysFlat: false,
      inviteBonusCredits: 0,
      dripCapSource: 'legacy',
    });
    const config = await resolveSignupGrantSettings(settings(prodOldKeys));
    expect([config.signupCredits, config.unlockCredits]).toEqual([1000, 9000]);
  });

  it('lets the new keys win over the old ones', async () => {
    const schedule = await resolveSignupGrantSchedule(
      settings({
        ...prodOldKeys,
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

  it('honours a stored 0 but treats an absent key as unset', async () => {
    const zero = await resolveSignupGrantSchedule(
      settings({ ...prodOldKeys, signupGrantInitialCredits: '0', signupGrantDailyCredits: '0', signupGrantDripCap: 0 })
    );
    expect([zero.initialCredits, zero.dailyCredits, zero.dripCap, zero.dripCapSource]).toEqual([0, 0, 0, 'setting']);
  });

  it.each(['', '  ', 'garbage', '-5', '1.5', null])('falls back past an invalid stored value %j', async value => {
    const schedule = await resolveSignupGrantSchedule(
      settings({
        ...prodOldKeys,
        signupGrantInitialCredits: value,
        signupGrantDailyCredits: value,
        signupGrantDripCap: value,
      })
    );
    expect([schedule.initialCredits, schedule.dailyCredits, schedule.dripCap]).toEqual([1000, 1000, 9000]);
    expect(schedule.dripCapSource).toBe('legacy');
  });

  it('takes the smaller legacy cap, or the one that is set', async () => {
    const staged = { stagedSignupGrantEnabled: 'true' };
    const both = await resolveSignupGrantSchedule(
      settings({ ...staged, signupGrantActivityMaxCredits: '9000', verifiedUnlockCredits: '5000' })
    );
    expect(both.dripCap).toBe(5000);
    const one = await resolveSignupGrantSchedule(settings({ ...staged, verifiedUnlockCredits: '7000' }));
    expect([one.dripCap, one.dripCapSource]).toEqual([7000, 'legacy']);
  });

  it.each([
    { max: '3000', verified: '9000', dripCap: 3000, unlockCredits: 9000 },
    { max: '9000', verified: '3000', dripCap: 3000, unlockCredits: 3000 },
  ])(
    'bounds the drip by the smaller legacy cap but enrolls verifiedUnlockCredits (max $max, verified $verified)',
    async ({ max, verified, dripCap, unlockCredits }) => {
      const values = { ...prodOldKeys, signupGrantActivityMaxCredits: max, verifiedUnlockCredits: verified };
      expect(await resolveSignupGrantSchedule(settings(values))).toMatchObject({ dripCap, unlockCredits });
      expect(await newSignupGrant(settings(values))).toMatchObject({ signupCredits: 1000, unlockCredits });
    }
  );

  it('keeps a legacy activity max of 0 as drip-off while verification still releases verifiedUnlockCredits', async () => {
    const values = {
      stagedSignupGrantEnabled: 'true',
      signupGrantActivityMaxCredits: '0',
      verifiedUnlockCredits: '9000',
    };
    const off = await resolveSignupGrantSchedule(settings(values));
    expect([off.dripCap, off.unlockCredits, off.paysFlat]).toEqual([0, 9000, false]);
    expect(await newSignupGrant(settings({ ...values, signupGrantCredits: '1000' }))).toMatchObject({
      signupCredits: 1000,
      unlockCredits: 9000,
    });
  });

  it('pays the flat grant with no drip while the schedule keys are unset and the retired toggles are off', async () => {
    const preMigration = {
      stagedSignupGrantEnabled: 'false',
      signupGrantActivityEnabled: 'false',
      defaultFreeCredits: '10000',
      signupGrantCredits: '1000',
      verifiedUnlockCredits: '9000',
      signupGrantActivityDailyCredits: '1000',
      signupGrantActivityMaxCredits: '9000',
    };
    expect(await resolveSignupGrantSchedule(settings(preMigration))).toEqual({
      initialCredits: 10000,
      dailyCredits: 0,
      dripCap: 0,
      unlockCredits: 0,
      paysFlat: true,
      inviteBonusCredits: 0,
      dripCapSource: 'legacy',
    });
    expect(await newSignupGrant(settings(preMigration))).toMatchObject({ signupCredits: 10000, unlockCredits: 0 });
    expect(await newSignupGrant(settings(preMigration), 200)).toMatchObject({ signupCredits: 200, unlockCredits: 0 });
    expect(await resolveSignupGrantSchedule(settings({}))).toMatchObject({ dripCap: 0, dripCapSource: 'legacy' });
  });

  it('keeps the legacy daily amount only while the retired activity toggle is on', async () => {
    const values = { stagedSignupGrantEnabled: 'true', signupGrantActivityDailyCredits: '1000' };
    expect((await resolveSignupGrantSchedule(settings(values))).dailyCredits).toBe(0);
    expect(
      (await resolveSignupGrantSchedule(settings({ ...values, signupGrantActivityEnabled: true }))).dailyCredits
    ).toBe(1000);
  });

  it('reports the registry default when staging is on and no cap key is set', async () => {
    const schedule = await resolveSignupGrantSchedule(settings({ stagedSignupGrantEnabled: 'true' }));
    expect(schedule).toEqual({
      initialCredits: 0,
      dailyCredits: 0,
      dripCap: 9000,
      unlockCredits: 9000,
      paysFlat: false,
      inviteBonusCredits: 0,
      dripCapSource: 'default',
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
  ] as const)('%j is open: %s', (grant, open) => {
    expect(signupGrantDripOpen(grant)).toBe(open);
  });
});
