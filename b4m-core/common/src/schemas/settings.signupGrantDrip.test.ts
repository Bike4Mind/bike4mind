import { describe, expect, it } from 'vitest';
import { selfUserResponseSchema } from './user';
import { API_SERVICE_GROUPS, SettingKeySchema, settingsMap } from './settings';
import { VERIFIED_UNLOCK_CREDITS_DEFAULT } from '../signupGrant';

describe('signup activity drip settings', () => {
  it('registers an admin-only preview test switch that defaults off', () => {
    const setting = settingsMap.signupGrantActivityPreviewTestMode;
    expect(setting.schema.parse(undefined)).toBe(false);
    expect(setting.schema.parse('true')).toBe(true);
    expect('userReadable' in setting && setting.userReadable).toBeFalsy();
    expect(SettingKeySchema.parse(setting.key)).toBe(setting.key);
    expect(API_SERVICE_GROUPS.CREDITS.settings).toContainEqual(expect.objectContaining({ key: setting.key }));
  });
  it('defaults the daily rate off and the cap to 9000, in the credits group', () => {
    const daily = settingsMap.signupGrantActivityDailyCredits;
    const max = settingsMap.signupGrantActivityMaxCredits;
    expect(daily.schema.parse(undefined)).toBe(0);
    expect(max.schema.parse(undefined)).toBe(9000);
    for (const entry of [daily, max]) {
      expect(SettingKeySchema.parse(entry.key)).toBe(entry.key);
      expect(API_SERVICE_GROUPS.CREDITS.settings).toContainEqual(expect.objectContaining({ key: entry.key }));
    }
  });

  it.each([-1, 1.5, 10001])('rejects an out-of-range daily rate %s', value => {
    expect(settingsMap.signupGrantActivityDailyCredits.schema.safeParse(value).success).toBe(false);
  });

  it('accepts a daily rate of 1000', () => {
    expect(settingsMap.signupGrantActivityDailyCredits.schema.parse(1000)).toBe(1000);
  });
});

describe('signup grant drip state on the self user schema', () => {
  const base = {
    stage: 'signup',
    signupCredits: 1000,
    unlockCredits: 9000,
    creditsReleased: 2000,
    nextCondition: 'verification',
  };
  const parse = (signupGrant: Record<string, unknown>) =>
    selfUserResponseSchema.shape.signupGrant.safeParse(signupGrant);

  it('accepts drip fields and the new unlock reasons', () => {
    const result = parse({ ...base, unlockedBy: 'activity_drip', dripCredits: 1000, lastDripDay: '2026-10-29' });
    expect(result.success).toBe(true);
    expect(parse({ ...base, unlockedBy: 'subscription' }).success).toBe(true);
    expect(parse({ ...base, lastDripPeriod: 'preview:5:1234' }).success).toBe(true);
    expect(parse({ ...base, lastDripPeriod: 'invalid' }).success).toBe(false);
  });

  it('treats absent drip fields as a legacy grant and rejects malformed ones', () => {
    expect(parse(base).success).toBe(true);
    expect(parse({ ...base, lastDripDay: '10/29/2026' }).success).toBe(false);
    expect(parse({ ...base, dripCredits: -1 }).success).toBe(false);
  });
});

describe('verified unlock credits setting', () => {
  it('declares the same default the signup grant falls back to', () => {
    const setting = settingsMap.verifiedUnlockCredits;
    expect(setting.clearDeletesRow).toBeUndefined();
    expect(setting.defaultValue).toBe(VERIFIED_UNLOCK_CREDITS_DEFAULT);
  });
});
