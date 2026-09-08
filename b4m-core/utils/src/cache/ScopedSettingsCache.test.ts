import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { IScopedSetting, ScopeRef, SettingKey, SettingScopeLevel } from '@bike4mind/common';
import { ScopedSettingsCache, scopedOverrideKey } from './ScopedSettingsCache';

const KEY = 'dataLakeSearchMaxFiles' as SettingKey;
const orgRef: ScopeRef = { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1' };
const lakeRef: ScopeRef = { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' };

function makeStore(rows: Array<Partial<IScopedSetting>>) {
  const findOverrides = vi.fn(
    async (scopes: ScopeRef[], names: string[]) =>
      rows.filter(
        r =>
          names.includes(r.settingName as string) &&
          scopes.some(s => s.scopeLevel === r.scopeLevel && s.scopeId === r.scopeId)
      ) as IScopedSetting[]
  );
  return { db: { scopedSettings: { findOverrides } }, findOverrides };
}

let cache: ScopedSettingsCache;
beforeEach(() => {
  cache = new ScopedSettingsCache(new Logger());
});

describe('ScopedSettingsCache', () => {
  it('returns an entry for every (scope, name) pair, value or null', async () => {
    const { db } = makeStore([
      { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1', settingName: KEY, settingValue: '2000' },
    ]);
    const out = await cache.getOverrides([orgRef, lakeRef], [KEY], db);
    expect(out.get(scopedOverrideKey(SettingScopeLevel.Organization, 'o1', KEY))).toBe('2000');
    expect(out.get(scopedOverrideKey(SettingScopeLevel.Lake, 'l1', KEY))).toBeNull(); // confirmed absence
  });

  it('serves a warm cache without re-querying (positive and negative)', async () => {
    const { db, findOverrides } = makeStore([
      { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1', settingName: KEY, settingValue: '2000' },
    ]);
    await cache.getOverrides([orgRef, lakeRef], [KEY], db);
    await cache.getOverrides([orgRef, lakeRef], [KEY], db);
    expect(findOverrides).toHaveBeenCalledTimes(1); // second call fully served from cache
  });

  it('re-queries after a rung is invalidated', async () => {
    const { db, findOverrides } = makeStore([
      { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1', settingName: KEY, settingValue: '2000' },
    ]);
    await cache.getOverrides([orgRef], [KEY], db);
    cache.invalidateScope(SettingScopeLevel.Organization, 'o1');
    await cache.getOverrides([orgRef], [KEY], db);
    expect(findOverrides).toHaveBeenCalledTimes(2);
  });

  it('touches neither cache nor store for a platform-altitude read (no rungs)', async () => {
    const { db, findOverrides } = makeStore([]);
    const out = await cache.getOverrides([], [KEY], db);
    expect(out.size).toBe(0);
    expect(findOverrides).not.toHaveBeenCalled();
  });

  it('batches all missing rungs and names into a single query', async () => {
    const { db, findOverrides } = makeStore([]);
    await cache.getOverrides([orgRef, lakeRef], [KEY, 'dataLakeSearchMaxChunks' as SettingKey], db);
    expect(findOverrides).toHaveBeenCalledTimes(1);
    const [scopesArg, namesArg] = findOverrides.mock.calls[0];
    expect(scopesArg).toHaveLength(2);
    expect(namesArg).toEqual(expect.arrayContaining([KEY, 'dataLakeSearchMaxChunks']));
  });
});
