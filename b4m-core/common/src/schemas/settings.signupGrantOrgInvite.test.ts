import { describe, expect, it } from 'vitest';
import { API_SERVICE_GROUPS, SettingKeySchema, settingsMap, userReadableSettingKeys } from './settings';

describe('organization invitation grant rollout setting', () => {
  it('defaults off and is available to the eligibility UI and credits settings group', () => {
    const entry = settingsMap.signupGrantOrgInviteEnabled;
    expect(entry.defaultValue).toBe(false);
    expect(entry.schema.parse(undefined)).toBe(false);
    expect(SettingKeySchema.parse(entry.key)).toBe('signupGrantOrgInviteEnabled');
    expect(userReadableSettingKeys()).toContain(entry.key);
    expect(API_SERVICE_GROUPS.CREDITS.settings).toContainEqual(expect.objectContaining({ key: entry.key }));
  });
});
