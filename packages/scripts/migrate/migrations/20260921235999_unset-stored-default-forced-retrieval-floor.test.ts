import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { _id: string; settingValue: unknown };
type Filter = Record<string, unknown>;

const { rows, deleteMany, findFilters, fakeModel } = vi.hoisted(() => {
  const rows: Record<'admin' | 'scoped', Row[]> = { admin: [], scoped: [] };
  const deleteMany = { admin: vi.fn(), scoped: vi.fn() };
  const findFilters: Filter[] = [];
  const fakeModel = (which: 'admin' | 'scoped') => ({
    find: (filter: Filter) => {
      findFilters.push(filter);
      return { lean: async () => rows[which] };
    },
    deleteMany: (filter: Filter, opts: Filter) => deleteMany[which](filter, opts),
  });
  return { rows, deleteMany, findFilters, fakeModel };
});

vi.mock('@bike4mind/database', () => ({ AdminSettings: fakeModel('admin'), ScopedSetting: fakeModel('scoped') }));

import migration, { isStoredDefault } from './20260921235999_unset-stored-default-forced-retrieval-floor';

beforeEach(() => {
  vi.clearAllMocks();
  findFilters.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  deleteMany.admin.mockResolvedValue({ deletedCount: 1 });
  deleteMany.scoped.mockResolvedValue({ deletedCount: 2 });
});

describe('unset-stored-default-forced-retrieval-floor', () => {
  it.each([75, '75', ' 75', '75.0'])('treats %j as a stored default', v => {
    expect(isStoredDefault(v)).toBe(true);
  });

  it.each([74, 76, '74', '', '  ', null, undefined, '7.5', 0.75, true])('leaves %j alone', v => {
    expect(isStoredDefault(v)).toBe(false);
  });

  it('hard-deletes only the stored-75 rows for this key, platform and overlay', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 75 }];
    rows.scoped = [
      { _id: 's1', settingValue: '75' },
      { _id: 's2', settingValue: '60' },
      { _id: 's3', settingValue: ' 75' },
    ];

    await migration.up();

    expect(findFilters).toEqual([
      { settingName: 'forcedRetrievalMinSimilarityPct' },
      { settingName: 'forcedRetrievalMinSimilarityPct' },
    ]);
    expect(deleteMany.admin).toHaveBeenCalledWith({ _id: { $in: ['a1'] } }, { hardDelete: true });
    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['s1', 's3'] } }, { hardDelete: true });
  });

  it('deletes nothing when no row holds 75, so a re-run is a no-op', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 60 }];
    rows.scoped = [];

    await migration.up();

    expect(deleteMany.admin).not.toHaveBeenCalled();
    expect(deleteMany.scoped).not.toHaveBeenCalled();
  });
});
