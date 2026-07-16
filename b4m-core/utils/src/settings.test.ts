import { describe, it, expect, vi } from 'vitest';
import { getSettingByName } from './settings';
import { AdminSettingsCache } from './cache/AdminSettingsCache';
import { Logger } from '@bike4mind/observability';

// Regression: a setting stored as boolean `false` (e.g. an admin-disabled defaultValue:true
// flag) must come back as `false`, not `null`. The old `|| null` collapsed it, letting callers
// fall back to the default and silently re-enable a disabled flag (fail-open).
const repoReturning = (settingValue: unknown) => ({
  findBySettingName: vi.fn().mockResolvedValue(settingValue === undefined ? null : { settingName: 'k', settingValue }),
});

describe('getSettingByName - stored boolean false survives the round-trip', () => {
  it('skipCache path returns false, not null', async () => {
    const db = { adminSettings: repoReturning(false) };
    const v: unknown = await getSettingByName('EnableQuestMaster', db, { skipCache: true });
    expect(v).toBe(false);
  });

  it('skipCache path returns null when the setting is absent', async () => {
    const db = { adminSettings: repoReturning(undefined) };
    const v: unknown = await getSettingByName('EnableQuestMaster', db, { skipCache: true });
    expect(v).toBeNull();
  });

  it('cached path (AdminSettingsCache) returns false, not null', async () => {
    const cache = new AdminSettingsCache(new Logger());
    // Unique name so the module-scope-free instance cache doesn't collide with other tests.
    const db = { adminSettings: repoReturning(false) };
    const v: unknown = await cache.getSettingByName('EnableFalseFlagRegression', db);
    expect(v).toBe(false);
  });
});
