import { describe, expect, it } from 'vitest';
import { newSignupGrant, resolveSignupGrantSchedule, resolveSignupGrantSettings } from './signupGrant';

const settings = (values: Record<string, unknown>) =>
  ({
    findBySettingName: async (name: string) => (name in values ? { settingValue: values[name] } : null),
  }) as unknown as Parameters<typeof newSignupGrant>[0];

describe('signup grant configuration', () => {
  it('does not enroll accounts unless explicitly enabled', async () => {
    expect(await newSignupGrant(settings({ defaultFreeCredits: '75' }))).toBeUndefined();
  });

  it.each(['0', '75', '-1', 'invalid'])(
    'preserves a restricted legacy setting %s and falls back to the default drip cap',
    async value => {
      const result = await resolveSignupGrantSettings(settings({ defaultFreeCredits: value }));
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
    const both = await resolveSignupGrantSchedule(
      settings({ signupGrantActivityMaxCredits: '9000', verifiedUnlockCredits: '5000' })
    );
    expect(both.dripCap).toBe(5000);
    const one = await resolveSignupGrantSchedule(settings({ verifiedUnlockCredits: '7000' }));
    expect([one.dripCap, one.dripCapSource]).toEqual([7000, 'legacy']);
    const off = await resolveSignupGrantSchedule(
      settings({ signupGrantActivityMaxCredits: '0', verifiedUnlockCredits: '9000' })
    );
    expect(off.dripCap).toBe(0);
  });

  it('reports the registry default when no cap key is set', async () => {
    const schedule = await resolveSignupGrantSchedule(settings({}));
    expect(schedule).toEqual({
      initialCredits: 0,
      dailyCredits: 0,
      dripCap: 9000,
      inviteBonusCredits: 0,
      dripCapSource: 'default',
    });
  });
});
