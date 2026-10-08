import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = { _id: string; settingValue: unknown; scopeLevel?: string; scopeId?: string };
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
    deleteMany: (...args: unknown[]) => deleteMany[which](...args),
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

const org = (_id: string, settingValue: unknown): Row => ({
  _id,
  settingValue,
  scopeLevel: 'organization',
  scopeId: _id,
});
const owner = (_id: string, settingValue: unknown): Row => ({ _id, settingValue, scopeLevel: 'owner', scopeId: _id });
const logs = () => vi.mocked(console.log).mock.calls.map(c => String(c[0]));

describe('unset-stored-default-forced-retrieval-floor', () => {
  it.each([75, '75', ' 75', '75.0'])('treats %j as a stored default', v => {
    expect(isStoredDefault(v)).toBe(true);
  });

  it.each([74, 76, '74', '', '  ', null, undefined, '7.5', 0.75, true])('leaves %j alone', v => {
    expect(isStoredDefault(v)).toBe(false);
  });

  it('removes only the stored-75 rows for this key, platform hard and overlay soft', async () => {
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
    // Scoped rows soft-delete (no options), so the override audit trail survives.
    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['s1', 's3'] } });
  });

  it('deletes nothing when no row holds 75, so a re-run is a no-op', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 60 }];
    rows.scoped = [];

    await migration.up();

    expect(deleteMany.admin).not.toHaveBeenCalled();
    expect(deleteMany.scoped).not.toHaveBeenCalled();
  });

  it('keeps and logs a scoped 75 over a different platform value, which it was shadowing', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 80 }];
    rows.scoped = [org('org-x', '75')];

    await migration.up();

    expect(deleteMany.scoped).not.toHaveBeenCalled();
    expect(deleteMany.admin).not.toHaveBeenCalled();
    expect(logs().some(l => l.includes('kept organization:org-x') && l.includes('80'))).toBe(true);
  });

  it.each([
    ['unset', []],
    ['blank', [{ _id: 'a1', settingValue: '  ' }]],
    ['unparseable', [{ _id: 'a1', settingValue: 'abc' }]],
  ])('removes a scoped 75 when the platform is %s', async (_label, admin) => {
    rows.admin = admin as Row[];
    rows.scoped = [org('org-x', '75'), owner('u1', 75)];

    await migration.up();

    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['org-x', 'u1'] } });
  });

  it('removes a platform 75 and the scoped 75s it neutralized', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 75 }];
    rows.scoped = [org('org-x', '75')];

    await migration.up();

    expect(deleteMany.admin).toHaveBeenCalledWith({ _id: { $in: ['a1'] } }, { hardDelete: true });
    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['org-x'] } });
  });

  it('keeps an owner 75 while any org row holds a different value, but still removes an org 75', async () => {
    rows.admin = [];
    rows.scoped = [org('org-60', '60'), org('org-75', '75'), owner('u1', '75')];

    await migration.up();

    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['org-75'] } });
    expect(logs().some(l => l.includes('kept owner:u1') && l.includes('60'))).toBe(true);
  });

  it.each([
    ['0', '0'],
    ['150', 150],
  ])('treats a schema-invalid platform %s as unset and removes the scoped 75', async (_label, value) => {
    rows.admin = [{ _id: 'a1', settingValue: value }];
    rows.scoped = [org('org-x', '75'), owner('u1', '75')];

    await migration.up();

    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['org-x', 'u1'] } });
  });

  it('removes an inert lake-rung 75 without logging it as kept', async () => {
    rows.admin = [{ _id: 'a1', settingValue: 80 }];
    rows.scoped = [{ _id: 'lake-1', settingValue: '75', scopeLevel: 'lake', scopeId: 'lake-1' }];

    await migration.up();

    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['lake-1'] } });
    expect(logs().some(l => l.includes('kept'))).toBe(false);
  });

  it('applies the stored-75 rule to a blank overlay row, which parses to 75', async () => {
    rows.admin = [];
    rows.scoped = [org('org-blank', ' ')];

    await migration.up();

    expect(deleteMany.scoped).toHaveBeenCalledWith({ _id: { $in: ['org-blank'] } });
  });
});
