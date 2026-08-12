import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  IScopedSetting,
  ScopeRef,
  SettingScope,
  SettingScopeLevel,
} from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import {
  applyClamp,
  computeCandidateRefs,
  pickOverride,
  resolveScopedSetting,
  resolveScopedSettingValues,
  scopeForFileOwner,
  scopeForLake,
} from './resolveScopedSetting';

const KEY = 'dataLakeSearchMaxFiles'; // registered settableAt [organization, owner, lake], number, min 1

const owner = { id: 'u1', type: CreditHolderType.User } as const;
const fullScope: SettingScope = { organizationId: 'o1', owner, lakeId: 'l1' };

/** Build a mock `db` whose platform table and override rows are fixed per test. */
function makeDb(
  platform: Record<string, string>,
  overrides: Array<Partial<IScopedSetting>> = [],
  opts?: { throwOverrides?: boolean }
) {
  return {
    adminSettings: {
      findAll: async () =>
        Object.entries(platform).map(([settingName, settingValue]) => ({ settingName, settingValue })),
      findBySettingNames: async (names: string[]) =>
        names.filter(n => platform[n] != null).map(n => ({ settingName: n, settingValue: platform[n] })),
    },
    scopedSettings: {
      findOverrides: async (scopes: ScopeRef[], names: string[]) => {
        if (opts?.throwOverrides) throw new Error('overlay down');
        return overrides.filter(
          o =>
            names.includes(o.settingName as string) &&
            scopes.some(s => s.scopeLevel === o.scopeLevel && s.scopeId === o.scopeId)
        ) as IScopedSetting[];
      },
    },
  } as const;
}

function override(scopeLevel: SettingScopeLevel, scopeId: string, settingValue: string): Partial<IScopedSetting> {
  return { scopeLevel: scopeLevel as IScopedSetting['scopeLevel'], scopeId, settingName: KEY, settingValue };
}

// The global caches are process-wide; reset both so each test reads its own mock repos fresh.
beforeEach(() => {
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

describe('computeCandidateRefs (rung gating - the decision-7 seam)', () => {
  it('returns rungs narrowest-first for a fully-scoped, all-rungs setting', () => {
    const refs = computeCandidateRefs(
      KEY,
      [SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake],
      false,
      fullScope,
      true
    );
    expect(refs.map(r => r.scopeLevel)).toEqual([
      SettingScopeLevel.Lake,
      SettingScopeLevel.Owner,
      SettingScopeLevel.Organization,
    ]);
  });

  it('excludes the lake rung when a setting is owner-only (chunk-policy / decision 7)', () => {
    const refs = computeCandidateRefs(KEY, [SettingScopeLevel.Owner], false, fullScope, true);
    expect(refs.map(r => r.scopeLevel)).toEqual([SettingScopeLevel.Owner]);
    expect(refs.some(r => r.scopeLevel === SettingScopeLevel.Lake)).toBe(false);
  });

  it('returns nothing for a platform-only setting (no settableAt)', () => {
    expect(computeCandidateRefs(KEY, undefined, false, fullScope, true)).toEqual([]);
    expect(computeCandidateRefs(KEY, [], false, fullScope, true)).toEqual([]);
  });

  it('returns nothing and warns for a sensitive setting even if scoped', () => {
    const logger = { warn: vi.fn() };
    const refs = computeCandidateRefs(KEY, [SettingScopeLevel.Owner], true, fullScope, true, logger as never);
    expect(refs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('refusing to scope sensitive'));
  });

  it('returns nothing when there is no scoped store', () => {
    expect(computeCandidateRefs(KEY, [SettingScopeLevel.Owner], false, fullScope, false)).toEqual([]);
  });

  it('warns and resolves wider rungs when owner is required but absent from scope', () => {
    const logger = { warn: vi.fn() };
    const refs = computeCandidateRefs(
      KEY,
      [SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake],
      false,
      { organizationId: 'o1' }, // no owner, no lake
      true,
      logger as never
    );
    expect(refs.map(r => r.scopeLevel)).toEqual([SettingScopeLevel.Organization]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no owner is in scope'));
  });
});

describe('pickOverride (narrower-wins + parse guard)', () => {
  const numberSchema = {
    safeParse: (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 ? { success: true, data: n } : { success: false };
    },
  };
  const refs: ScopeRef[] = [
    { scopeLevel: SettingScopeLevel.Lake, scopeId: 'l1' },
    { scopeLevel: SettingScopeLevel.Owner, scopeId: 'u1' },
    { scopeLevel: SettingScopeLevel.Organization, scopeId: 'o1' },
  ];
  const key = (lvl: SettingScopeLevel, id: string) => JSON.stringify([lvl, id, KEY]);

  it('picks the narrowest rung that has a value', () => {
    const overrides = new Map<string, string | null>([
      [key(SettingScopeLevel.Owner, 'u1'), '1500'],
      [key(SettingScopeLevel.Organization, 'o1'), '2000'],
    ]);
    expect(pickOverride(KEY, refs, overrides, numberSchema)).toEqual({ value: 1500, source: SettingScopeLevel.Owner });
  });

  it('skips an unparseable narrower override and warns, falling through to the next rung', () => {
    const logger = { warn: vi.fn() };
    const overrides = new Map<string, string | null>([
      [key(SettingScopeLevel.Lake, 'l1'), 'not-a-number'],
      [key(SettingScopeLevel.Organization, 'o1'), '2000'],
    ]);
    expect(pickOverride(KEY, refs, overrides, numberSchema, logger as never)).toEqual({
      value: 2000,
      source: SettingScopeLevel.Organization,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unparseable override'));
  });

  it('returns null when no rung has a value (caller keeps platform)', () => {
    expect(pickOverride(KEY, refs, new Map(), numberSchema)).toBeNull();
  });
});

describe('applyClamp (safety rail)', () => {
  const windowClamp = (v: number) => Math.min(v, 6554);
  it('clamps a numeric value above the rail', () => {
    expect(applyClamp(8000, fullScope, windowClamp)).toBe(6554);
  });
  it('leaves a value under the rail untouched', () => {
    expect(applyClamp(512, fullScope, windowClamp)).toBe(512);
  });
  it('is a no-op with no clamp or a non-numeric value', () => {
    expect(applyClamp(8000, fullScope, undefined)).toBe(8000);
    expect(applyClamp('str', fullScope, windowClamp)).toBe('str');
  });
});

describe('resolveScopedSetting (integration, through the real settingsMap)', () => {
  it('returns the platform value with an empty scope', async () => {
    const db = makeDb({ [KEY]: '3000' });
    const r = await resolveScopedSetting(KEY, {}, db);
    expect(r).toEqual({ value: 3000, source: SettingScopeLevel.Platform });
  });

  it('falls back to the coded default when there is no platform row', async () => {
    const db = makeDb({});
    const r = await resolveScopedSetting(KEY, {}, db);
    expect(r.value).toBe(DATA_LAKE_SEARCH_MAX_FILES_DEFAULT);
    expect(r.source).toBe(SettingScopeLevel.Platform);
  });

  it('an org override beats platform', async () => {
    const db = makeDb({ [KEY]: '3000' }, [override(SettingScopeLevel.Organization, 'o1', '2000')]);
    const r = await resolveScopedSetting(KEY, { organizationId: 'o1', owner }, db);
    expect(r).toEqual({ value: 2000, source: SettingScopeLevel.Organization });
  });

  it('owner beats org when no lake override exists', async () => {
    const db = makeDb({ [KEY]: '3000' }, [
      override(SettingScopeLevel.Organization, 'o1', '2000'),
      override(SettingScopeLevel.Owner, 'u1', '1500'),
    ]);
    const r = await resolveScopedSetting(KEY, { organizationId: 'o1', owner }, db);
    expect(r).toEqual({ value: 1500, source: SettingScopeLevel.Owner });
  });

  it('lake beats owner and org (narrowest wins)', async () => {
    const db = makeDb({ [KEY]: '3000' }, [
      override(SettingScopeLevel.Organization, 'o1', '2000'),
      override(SettingScopeLevel.Owner, 'u1', '1500'),
      override(SettingScopeLevel.Lake, 'l1', '1000'),
    ]);
    const r = await resolveScopedSetting(KEY, fullScope, db);
    expect(r).toEqual({ value: 1000, source: SettingScopeLevel.Lake });
  });

  it('ignores overrides when no scoped store is wired (platform-only db)', async () => {
    const db = makeDb({ [KEY]: '3000' }, [override(SettingScopeLevel.Lake, 'l1', '1000')]);
    const platformOnly = { adminSettings: db.adminSettings };
    const r = await resolveScopedSetting(KEY, fullScope, platformOnly);
    expect(r).toEqual({ value: 3000, source: SettingScopeLevel.Platform });
  });

  it('degrades to the platform value (and warns) when the overlay read throws', async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const db = makeDb({ [KEY]: '3000' }, [], { throwOverrides: true });
    const r = await resolveScopedSetting(KEY, fullScope, db, { logger: logger as never });
    expect(r).toEqual({ value: 3000, source: SettingScopeLevel.Platform });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('overlay read failed'), expect.anything());
  });

  it('resolves several keys in one call, each keeping its own value', async () => {
    const db = makeDb({ dataLakeSearchMaxFiles: '3000', dataLakeSearchMaxChunks: '50000' }, [
      override(SettingScopeLevel.Lake, 'l1', '1000'),
    ]);
    const values = await resolveScopedSettingValues(
      ['dataLakeSearchMaxFiles', 'dataLakeSearchMaxChunks'],
      fullScope,
      db
    );
    expect(values.dataLakeSearchMaxFiles).toBe(1000); // lake override
    expect(values.dataLakeSearchMaxChunks).toBe(50000); // no override -> platform
  });
});

describe('scope builders', () => {
  it('scopeForLake: an org-owned lake is owned by the Organization', () => {
    expect(scopeForLake({ id: 'l1', createdByUserId: 'u1', organizationId: 'o1' })).toEqual({
      organizationId: 'o1',
      owner: { id: 'o1', type: CreditHolderType.Organization },
      lakeId: 'l1',
    });
  });

  it('scopeForLake: an org-less lake (empty string) is individually owned', () => {
    expect(scopeForLake({ id: 'l1', createdByUserId: 'u1', organizationId: '' })).toEqual({
      organizationId: undefined,
      owner: { id: 'u1', type: CreditHolderType.User },
      lakeId: 'l1',
    });
  });

  it('scopeForFileOwner: file-owner altitude, no lake rung (decision 7)', () => {
    const s = scopeForFileOwner({ userId: 'u1', organizationId: 'o1' });
    expect(s.owner).toEqual({ id: 'u1', type: CreditHolderType.User });
    expect(s.organizationId).toBe('o1');
    expect(s.lakeId).toBeUndefined();
  });
});
