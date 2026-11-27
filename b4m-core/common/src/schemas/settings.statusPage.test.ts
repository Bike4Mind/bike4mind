import { describe, it, expect } from 'vitest';
import { FULL_ADMIN_SETTING_KEYS } from '../adminPermissions';
import { API_SERVICE_GROUPS, SettingKeySchema, publicSafeSettingKeys, settingsMap } from './settings';

const DEFAULTS = {
  statusPageEnabled: false,
  statusPagePublicEnabled: false,
  statusPageVendorFeedsEnabled: true,
  statusPageSyntheticLlmEnabled: false,
} as const;

describe('status page settings', () => {
  it.each(Object.entries(DEFAULTS))('%s is an Admin boolean defaulting to %s', (key, defaultValue) => {
    expect(SettingKeySchema.safeParse(key).success).toBe(true);
    const setting = settingsMap[key as keyof typeof DEFAULTS];
    expect(setting).toMatchObject({ type: 'boolean', category: 'Admin', defaultValue });
    expect(setting.group).toBe(API_SERVICE_GROUPS.ADMIN.id);
    expect(API_SERVICE_GROUPS.ADMIN.settings.map(s => s.key)).toContain(key);
  });

  it('exposes none of them to the public config artifact', () => {
    const publicKeys = new Set<string>(publicSafeSettingKeys());
    for (const key of Object.keys(DEFAULTS)) expect(publicKeys.has(key)).toBe(false);
  });

  it('limits the tick, public page and synthetic probe switches to full admins', () => {
    for (const key of ['statusPageEnabled', 'statusPagePublicEnabled', 'statusPageSyntheticLlmEnabled']) {
      expect(FULL_ADMIN_SETTING_KEYS.has(key)).toBe(true);
    }
    expect(FULL_ADMIN_SETTING_KEYS.has('statusPageVendorFeedsEnabled')).toBe(false);
  });
});
