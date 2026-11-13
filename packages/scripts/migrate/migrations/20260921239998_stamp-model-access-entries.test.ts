import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuditRow = { occurredAt: Date; changes: { field: string; before: unknown; after: unknown }[] };

const { findSetting, findAudits, updateOne, auditRows } = vi.hoisted(() => ({
  findSetting: vi.fn(),
  findAudits: vi.fn(),
  updateOne: vi.fn(),
  auditRows: { rows: [] as AuditRow[], read: 0 },
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: () => ({ lean: findSetting }), updateOne },
  AdminAuditLogModel: {
    find: (...args: unknown[]) => {
      findAudits(...args);
      return {
        sort: () => ({
          lean: () => ({
            cursor: async function* () {
              for (const row of auditRows.rows) {
                auditRows.read++;
                yield row;
              }
            },
          }),
        }),
      };
    },
  },
}));
const auditsNewestFirst = (rows: AuditRow[]) => {
  auditRows.rows = rows;
  auditRows.read = 0;
};
const accessChange = (occurredAt: string, before: unknown, after: unknown): AuditRow => ({
  occurredAt: new Date(occurredAt),
  changes: [{ field: 'llmModelConfigurations', before, after }],
});

const { default: migration } = await import('./20260921239998_stamp-model-access-entries');

const DOC_UPDATED = new Date('2026-11-01T00:00:00Z');
const stampFor = (id: string) => updateOne.mock.calls.find(call => call[0].settingValue.$elemMatch.id === id)?.[1];

describe('stamp-model-access-entries migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('stamps each unstamped entry from the newest audit that changed it, else the document time', async () => {
    const stamped = new Date('2026-10-30T00:00:00Z');
    findSetting.mockResolvedValue({
      updatedAt: DOC_UPDATED,
      settingValue: [
        { id: 'a', enabled: true, allowedUserTags: [] },
        { id: 'b', enabled: false, allowedUserTags: [] },
        { id: 'c', enabled: true, allowedUserTags: [], updatedAt: stamped },
      ],
    });
    auditsNewestFirst([
      accessChange(
        '2026-10-25T00:00:00Z',
        [
          { id: 'a', enabled: true, allowedUserTags: [] },
          { id: 'b', enabled: true, allowedUserTags: [] },
        ],
        [
          { id: 'a', enabled: true, allowedUserTags: [] },
          { id: 'b', enabled: false, allowedUserTags: [] },
        ]
      ),
      accessChange('2026-10-23T00:00:00Z', null, [{ id: 'b', enabled: true }]),
    ]);

    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(stampFor('b')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': new Date('2026-10-25T00:00:00Z') } });
    expect(stampFor('a')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': DOC_UPDATED } });
    expect(stampFor('c')).toBeUndefined();
    expect(findAudits).toHaveBeenCalledWith(expect.any(Object), { occurredAt: 1, changes: 1 });
  });

  it('ignores a save that only reordered the keys of an entry', async () => {
    findSetting.mockResolvedValue({
      updatedAt: DOC_UPDATED,
      settingValue: [{ id: 'a', enabled: true, allowedUserTags: [], fallbackModel: 'm', rank: 2 }],
    });
    auditsNewestFirst([
      accessChange(
        '2026-10-25T00:00:00Z',
        [{ id: 'a', enabled: true, allowedUserTags: [], fallbackModel: 'm', rank: 2, allowedEntitlements: ['base'] }],
        [{ id: 'a', enabled: true, allowedUserTags: [], allowedEntitlements: ['base'], fallbackModel: 'm', rank: 2 }]
      ),
      accessChange('2026-10-20T00:00:00Z', [], [{ id: 'a', enabled: true }]),
    ]);

    await migration.up();

    expect(stampFor('a')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': new Date('2026-10-20T00:00:00Z') } });
  });

  it('stops reading audits once every unstamped entry has its stamp', async () => {
    findSetting.mockResolvedValue({ updatedAt: DOC_UPDATED, settingValue: [{ id: 'a', enabled: false }] });
    auditsNewestFirst([
      accessChange('2026-10-25T00:00:00Z', [{ id: 'a', enabled: true }], [{ id: 'a', enabled: false }]),
      accessChange('2026-10-20T00:00:00Z', [], [{ id: 'a', enabled: true }]),
      accessChange('2026-10-15T00:00:00Z', [], []),
    ]);

    await migration.up();

    expect(auditRows.read).toBe(1);
    expect(stampFor('a')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': new Date('2026-10-25T00:00:00Z') } });
  });

  it('writes only to an entry that is still unstamped', async () => {
    findSetting.mockResolvedValue({ updatedAt: DOC_UPDATED, settingValue: [{ id: 'a', enabled: true }] });
    auditsNewestFirst([]);

    await migration.up();

    expect(updateOne).toHaveBeenCalledWith(
      { settingName: 'llmModelConfigurations', settingValue: { $elemMatch: { id: 'a', updatedAt: null } } },
      { $set: { 'settingValue.$[entry].updatedAt': DOC_UPDATED } },
      { arrayFilters: [{ 'entry.id': 'a', 'entry.updatedAt': null }] }
    );
  });

  it('does nothing without a document or when every entry is stamped', async () => {
    findSetting.mockResolvedValue(null);
    await migration.up();
    findSetting.mockResolvedValue({ settingValue: [{ id: 'a', updatedAt: DOC_UPDATED }] });
    await migration.up();

    expect(updateOne).not.toHaveBeenCalled();
  });
});
