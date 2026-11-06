import { describe, expect, it } from 'vitest';
import { selfUserResponseSchema } from './user';
import { API_SERVICE_GROUPS, SettingKeySchema, settingsMap } from './settings';

describe('signup activity drip settings', () => {
  it('registers an admin-only preview test switch that defaults off', () => {
    const setting = settingsMap.signupGrantActivityPreviewTestMode;
    expect(setting.schema.parse(undefined)).toBe(false);
    expect(setting.schema.parse('true')).toBe(true);
    expect('userReadable' in setting && setting.userReadable).toBeFalsy();
    expect(SettingKeySchema.parse(setting.key)).toBe(setting.key);
    expect(API_SERVICE_GROUPS.CREDITS.settings).toContainEqual(expect.objectContaining({ key: setting.key }));
  });
});

describe('signup grant schedule settings', () => {
  it.each([
    ['signupGrantInitialCredits', 0],
    ['signupGrantDailyCredits', 0],
    ['signupGrantDripCap', 9000],
    ['signupGrantInviteBonusCredits', 0],
  ] as const)('registers %s as a user-readable credits setting defaulting to %s', (key, fallback) => {
    const setting = settingsMap[key];
    expect(setting.schema.parse(undefined)).toBe(fallback);
    expect(setting.schema.parse('0')).toBe(0);
    expect(setting.schema.safeParse(-1).success).toBe(false);
    expect(setting.schema.safeParse(1.5).success).toBe(false);
    expect(setting.userReadable).toBe(true);
    expect(SettingKeySchema.parse(key)).toBe(key);
    expect(API_SERVICE_GROUPS.CREDITS.settings).toContainEqual(expect.objectContaining({ key }));
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

describe('retired signup grant settings', () => {
  const retired = [
    'signupGrantActivityMinMessages',
    'signupGrantActivityMinDays',
    'defaultSeats',
    'verifiedUnlockCredits',
    'signupGrantActivityMaxCredits',
    'signupGrantActivityEnabled',
    'signupGrantActivityDailyCredits',
    'stagedSignupGrantEnabled',
    'defaultFreeCredits',
    'signupGrantCredits',
    'signupGrantDailyBudget',
  ];

  it.each(retired)('%s is gone from the registry, the key schema and every admin group', key => {
    expect(key in settingsMap).toBe(false);
    expect(SettingKeySchema.safeParse(key).success).toBe(false);
    for (const group of Object.values(API_SERVICE_GROUPS)) {
      expect(group.settings.map(entry => entry.key)).not.toContain(key);
    }
  });
});
