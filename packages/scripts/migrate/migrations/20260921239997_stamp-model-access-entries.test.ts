import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findSetting, findAudits, updateOne } = vi.hoisted(() => ({
  findSetting: vi.fn(),
  findAudits: vi.fn(),
  updateOne: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  AdminSettings: { findOne: () => ({ lean: findSetting }), updateOne },
  AdminAuditLogModel: { find: () => ({ sort: () => ({ lean: findAudits }) }) },
}));

const { default: migration } = await import('./20260921239997_stamp-model-access-entries');

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
    findAudits.mockResolvedValue([
      {
        occurredAt: new Date('2026-10-25T00:00:00Z'),
        changes: [
          {
            field: 'llmModelConfigurations',
            before: [
              { id: 'a', enabled: true, allowedUserTags: [] },
              { id: 'b', enabled: true, allowedUserTags: [] },
            ],
            after: [
              { id: 'a', enabled: true, allowedUserTags: [] },
              { id: 'b', enabled: false, allowedUserTags: [] },
            ],
          },
        ],
      },
      {
        occurredAt: new Date('2026-10-23T00:00:00Z'),
        changes: [{ field: 'llmModelConfigurations', before: null, after: [{ id: 'b', enabled: true }] }],
      },
    ]);

    await migration.up();

    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(stampFor('b')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': new Date('2026-10-25T00:00:00Z') } });
    expect(stampFor('a')).toEqual({ $set: { 'settingValue.$[entry].updatedAt': DOC_UPDATED } });
    expect(stampFor('c')).toBeUndefined();
  });

  it('writes only to an entry that is still unstamped', async () => {
    findSetting.mockResolvedValue({ updatedAt: DOC_UPDATED, settingValue: [{ id: 'a', enabled: true }] });
    findAudits.mockResolvedValue([]);

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
