import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IScopedSetting, SettingScopeLevel } from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { resolveScopedSetting } from './resolveScopedSetting';
import { clearScopedOverride, writeScopedOverride } from './writeScopedOverride';

const KEY = 'dataLakeSearchMaxFiles'; // registered settableAt [organization, owner, lake], number, min 1
// No `scope` metadata at all, so the "not settable" refusal fires before the (also true) isSensitive
// check ever would - no registered setting is both scoped and sensitive (settings.scopeMetadata.test.ts
// enforces that), so the isSensitive branch has no real key to exercise; it is the same kind of
// defensive backstop as computeCandidateRefs' own isSensitive check.
const NOT_SETTABLE_KEY = 'openaiDemoKey';

const lakeRef = { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' } as const;
const ownerRef = { scopeLevel: SettingScopeLevel.Owner, scopeId: 'u1' } as const;
const fullScope = { organizationId: 'o1', owner: { id: 'u1', type: 'User' as const }, lakeId: 'l1' };

/**
 * A writable mock db, distinct from resolveScopedSetting.test.ts's read-only `makeDb`: upsert/clear
 * mutate the same in-memory `overrides` array `findOverrides` reads from, so a write made through the
 * writer under test is visible to a subsequent resolve within the same test.
 */
function makeWritableDb(platform: Record<string, string> = {}) {
  const overrides: Partial<IScopedSetting>[] = [];
  const scopedSettings = {
    findOverrides: async (scopes: { scopeLevel: string; scopeId: string }[], names: string[]) =>
      overrides.filter(
        o =>
          names.includes(o.settingName as string) &&
          scopes.some(s => s.scopeLevel === o.scopeLevel && s.scopeId === o.scopeId)
      ) as IScopedSetting[],
    upsertOverride: async (write: Partial<IScopedSetting>) => {
      const i = overrides.findIndex(
        o => o.scopeLevel === write.scopeLevel && o.scopeId === write.scopeId && o.settingName === write.settingName
      );
      if (i >= 0) overrides[i] = { ...overrides[i], ...write };
      else overrides.push(write);
      return write as IScopedSetting;
    },
    clearOverride: async (ref: { scopeLevel: string; scopeId: string; settingName: string }) => {
      // Hard-removes from the array here; the real repository soft-deletes (deletedAt stamp via
      // softDeletePlugin). This mock only needs to match findOverrides' read-side effect (the row is
      // gone from reads), not the real delete mechanism.
      const i = overrides.findIndex(
        o => o.scopeLevel === ref.scopeLevel && o.scopeId === ref.scopeId && o.settingName === ref.settingName
      );
      if (i >= 0) overrides.splice(i, 1);
    },
  };
  const adminSettings = {
    findAll: async () => Object.entries(platform).map(([settingName, settingValue]) => ({ settingName, settingValue })),
    findBySettingNames: async (names: string[]) =>
      names.filter(n => platform[n] != null).map(n => ({ settingName: n, settingValue: platform[n] })),
  };
  return { adminSettings, scopedSettings };
}

// The global scoped-settings cache is process-wide; reset it so a write in one test can't leave a
// stale cache entry for the next.
beforeEach(() => {
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

describe('writeScopedOverride validation (fails loud, never reaches the db on refusal)', () => {
  it('refuses a key with no settable rungs', async () => {
    const db = makeWritableDb();
    const spy = vi.spyOn(db.scopedSettings, 'upsertOverride');
    await expect(writeScopedOverride(NOT_SETTABLE_KEY, lakeRef, 'sk-whatever', db)).rejects.toThrow(/not settable/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an unparseable value', async () => {
    const db = makeWritableDb();
    const spy = vi.spyOn(db.scopedSettings, 'upsertOverride');
    await expect(writeScopedOverride(KEY, lakeRef, 'not-a-number', db)).rejects.toThrow(/validation/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a value below the schema minimum (edge value, not a truthy check)', async () => {
    const db = makeWritableDb();
    const spy = vi.spyOn(db.scopedSettings, 'upsertOverride');
    await expect(writeScopedOverride(KEY, lakeRef, '0', db)).rejects.toThrow(/validation/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses an owner-scoped write with no ownerType', async () => {
    const db = makeWritableDb();
    const spy = vi.spyOn(db.scopedSettings, 'upsertOverride');
    await expect(writeScopedOverride(KEY, ownerRef, '1000', db)).rejects.toThrow(/ownerType is required/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses ownerType on a non-owner-scoped write', async () => {
    const db = makeWritableDb();
    const spy = vi.spyOn(db.scopedSettings, 'upsertOverride');
    await expect(writeScopedOverride(KEY, { ...lakeRef, ownerType: 'User' as const }, '1000', db)).rejects.toThrow(
      /only meaningful at the owner scope/
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('writeScopedOverride / clearScopedOverride: read-your-writes against the real cache singleton (#1728)', () => {
  it('a write is visible on the very next resolve, even though a prior resolve cached the absence', async () => {
    const db = makeWritableDb({ [KEY]: '3000' });

    // Warm the negative cache for this rung: no override exists yet, so this resolve caches "absent".
    const before = await resolveScopedSetting(KEY, fullScope, db);
    expect(before).toEqual({ value: 3000, source: SettingScopeLevel.Platform });

    await writeScopedOverride(KEY, lakeRef, '1000', db);

    // Without invalidateScopedSettingsCache actually firing, this would still read the stale negative
    // entry cached above and wrongly return the platform value - this is the regression test for the
    // "forgetting to invalidate" trap the issue describes.
    const after = await resolveScopedSetting(KEY, fullScope, db);
    expect(after).toEqual({ value: 1000, source: SettingScopeLevel.Lake });
  });

  it('clearing an override falls back to the next wider scope on the very next resolve', async () => {
    const db = makeWritableDb({ [KEY]: '3000' });
    await writeScopedOverride(KEY, lakeRef, '1000', db);

    const before = await resolveScopedSetting(KEY, fullScope, db);
    expect(before).toEqual({ value: 1000, source: SettingScopeLevel.Lake });

    await clearScopedOverride(KEY, lakeRef, db);

    const after = await resolveScopedSetting(KEY, fullScope, db);
    expect(after).toEqual({ value: 3000, source: SettingScopeLevel.Platform });
  });
});
