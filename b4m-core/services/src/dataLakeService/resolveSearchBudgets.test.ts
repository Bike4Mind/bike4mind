import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  IScopedSetting,
  ScopeRef,
  SettingScope,
  SettingScopeLevel,
} from '@bike4mind/common';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { resolveSearchBudgets } from './resolveSearchBudgets';

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
  };
}

const scope: SettingScope = { organizationId: 'o1', owner: { id: 'u1', type: CreditHolderType.User }, lakeId: 'l1' };

beforeEach(() => {
  invalidateSettingsCache();
  invalidateScopedSettingsCache();
});

describe('resolveSearchBudgets - platform path (unchanged behavior)', () => {
  it('uses coded defaults when no rows exist', async () => {
    const budgets = await resolveSearchBudgets(makeDb({}));
    expect(budgets).toEqual({
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
    });
  });

  it('uses configured platform values', async () => {
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '10', dataLakeSearchMaxChunks: '200' })
    );
    expect(budgets).toEqual({ maxFiles: 10, maxChunks: 200 });
  });

  it('floors a non-integer and ignores an unusable value with a warning', async () => {
    const logger = { warn: vi.fn() };
    // maxChunks '0' is < 1 (unusable -> default + warn); maxFiles '7.9' floors to 7.
    const budgets = await resolveSearchBudgets(
      makeDb({ dataLakeSearchMaxFiles: '7.9', dataLakeSearchMaxChunks: '0' }),
      logger as never
    );
    expect(budgets.maxFiles).toBe(7);
    expect(budgets.maxChunks).toBe(DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unusable maxChunks'));
  });

  it('takes the platform path when a scope is passed but no scoped store is wired', async () => {
    const db = makeDb({ dataLakeSearchMaxFiles: '3000' });
    const budgets = await resolveSearchBudgets({ adminSettings: db.adminSettings }, undefined, scope);
    expect(budgets.maxFiles).toBe(3000);
  });
});

describe('resolveSearchBudgets - scoped path', () => {
  it('a narrower override tightens the budget below the platform ceiling', async () => {
    const db = makeDb({ dataLakeSearchMaxFiles: '3000', dataLakeSearchMaxChunks: '50000' }, [
      {
        scopeLevel: SettingScopeLevel.Lake,
        scopeId: 'l1',
        settingName: 'dataLakeSearchMaxFiles',
        settingValue: '1000',
      },
    ]);
    const budgets = await resolveSearchBudgets(db, undefined, scope);
    expect(budgets.maxFiles).toBe(1000); // lake override
    expect(budgets.maxChunks).toBe(50000); // no override -> platform
  });

  it('falls back to the platform path if scoped resolution throws', async () => {
    const logger = { warn: vi.fn() };
    const db = makeDb({ dataLakeSearchMaxFiles: '3000' }, [], { throwOverrides: true });
    const budgets = await resolveSearchBudgets(db, logger as never, scope);
    expect(budgets.maxFiles).toBe(3000);
  });
});
