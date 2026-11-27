import { describe, it, expect } from 'vitest';
import { settingsMap, API_SERVICE_GROUPS, type SettingKey } from './settings';

const KEYS = [
  'oauthAbuseAutoBlockEnabled',
  'oauthAbuseAttemptThreshold',
  'oauthAbuseWindowMinutes',
  'oauthAbuseBlockEscalationMinutes',
  'oauthAbuseLookbackHours',
  'oauthRateLimitPerIp',
  'oauthRateLimitWindowMinutes',
] as const satisfies readonly SettingKey[];

describe('OAuth abuse settings', () => {
  it('puts every key in the AUTH_ABUSE group under SecOps', () => {
    for (const key of KEYS) {
      expect(settingsMap[key].group).toBe(API_SERVICE_GROUPS.AUTH_ABUSE.id);
      expect(settingsMap[key].category).toBe('SecOps');
    }
    expect(API_SERVICE_GROUPS.AUTH_ABUSE.settings.map(s => s.key)).toEqual(KEYS);
  });

  it('declares the documented defaults', () => {
    expect(KEYS.map(key => settingsMap[key].defaultValue)).toEqual([true, 20, 10, '10,60,1440', 24, 40, 10]);
  });

  it.each([
    ['oauthAbuseAttemptThreshold', 0, undefined],
    ['oauthAbuseWindowMinutes', 0, 1441],
    ['oauthAbuseLookbackHours', 0, 721],
    ['oauthRateLimitPerIp', 0, undefined],
    ['oauthRateLimitWindowMinutes', 0, undefined],
  ] as const)('%s rejects out-of-range values', (key, low, high) => {
    const { schema } = settingsMap[key];
    expect(schema.safeParse(low).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    if (high !== undefined) expect(schema.safeParse(high).success).toBe(false);
    expect(schema.safeParse(5).success).toBe(true);
  });

  it.each(['10,abc', '10,0', '10,,60', '-5', '1.5', '1000000000000', '9'.repeat(400)])(
    'rejects the malformed escalation schedule %j',
    value => {
      expect(settingsMap.oauthAbuseBlockEscalationMinutes.schema.safeParse(value).success).toBe(false);
    }
  );

  it.each(['', '10,60,1440', ' 5, 30 '])('accepts the escalation schedule %j', value => {
    expect(settingsMap.oauthAbuseBlockEscalationMinutes.schema.safeParse(value).success).toBe(true);
  });
});
