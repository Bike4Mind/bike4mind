import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DATA_LAKE_STATUSES, FabFileSourceType, type AccessContext } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { getUserStorageBreakdown, type GetUserStorageBreakdownAdapters } from './getUserStorageBreakdown';
import { createMockFabFileRepository, createMockUser, createMockUserRepository } from '../__tests__/utils/testUtils';

const group = (over: Record<string, unknown>) => ({
  sourceType: null,
  sourceLakeId: null,
  mimeType: null,
  archived: false,
  bytes: 0,
  fileCount: 1,
  ...over,
});

const accessContext = (over: Partial<AccessContext> = {}): AccessContext => ({
  userId: 'user-1',
  isAdmin: false,
  userTags: [],
  organizationIds: [],
  ...over,
});

describe('getUserStorageBreakdown', () => {
  const lake = (over: Record<string, unknown>) => ({ createdByUserId: 'user-1', status: 'active', ...over });
  const db = {
    users: createMockUserRepository(),
    fabFiles: createMockFabFileRepository(),
    dataLakes: { findByIds: vi.fn() },
  };
  const adapters = { db } as unknown as GetUserStorageBreakdownAdapters;

  beforeEach(() => {
    vi.clearAllMocks();
    db.dataLakes.findByIds.mockResolvedValue([lake({ id: 'lake-a', name: 'Sales Drive' })]);
    db.users.findById.mockResolvedValue(createMockUser({ currentStorageSize: 1000 }));
  });

  it('resolves lake names and reports the gap to the counter as unaccounted', async () => {
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'lake-a', bytes: 600 }),
      group({ sourceType: FabFileSourceType.GITHUB, sourceLakeId: 'lake-gone', bytes: 100 }),
      group({ bytes: 250 }),
    ]);

    const result = await getUserStorageBreakdown(accessContext(), adapters, { maxTimeMS: 1234 });

    expect(db.fabFiles.summarizeChargedStorageByUserId).toHaveBeenCalledWith('user-1', { maxTimeMS: 1234 });
    expect(db.dataLakes.findByIds).toHaveBeenCalledWith(['lake-a', 'lake-gone']);
    expect(result).toMatchObject({ totalBytes: 1000, accountedBytes: 950, unaccountedBytes: 50 });
    expect(result.buckets.map(b => [b.key, b.lakeName])).toEqual([
      ['google_drive:lake-a', 'Sales Drive'],
      ['manual_upload', undefined],
      ['github:lake-gone', null],
    ]);
  });

  it('names an org lake another member created when the caller belongs to its org', async () => {
    db.dataLakes.findByIds.mockResolvedValue([
      lake({ id: 'org-lake', name: 'Team Drive', createdByUserId: 'someone-else', organizationId: 'org-1' }),
    ]);
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'org-lake', bytes: 2 }),
    ]);
    const member = await getUserStorageBreakdown(accessContext({ organizationIds: ['org-1'] }), adapters);
    expect(member.buckets.map(b => b.lakeName)).toEqual(['Team Drive']);
    const outsider = await getUserStorageBreakdown(accessContext({ organizationIds: ['org-2'] }), adapters);
    expect(outsider.buckets.map(b => b.lakeName)).toEqual([null]);
  });

  it.each(DATA_LAKE_STATUSES)('names an own lake in status %s only when it is draft or active', async status => {
    db.dataLakes.findByIds.mockResolvedValue([lake({ id: 'own-lake', name: 'Mine', status })]);
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([
      group({ sourceType: FabFileSourceType.GITHUB, sourceLakeId: 'own-lake', bytes: 1 }),
    ]);
    const result = await getUserStorageBreakdown(accessContext(), adapters);
    expect(result.buckets[0].lakeName).toBe(status === 'draft' || status === 'active' ? 'Mine' : null);
  });

  it('withholds the name of a lake the caller cannot read or that is not live', async () => {
    db.dataLakes.findByIds.mockResolvedValue([
      lake({ id: 'org-lake', name: 'Org Secrets', createdByUserId: 'someone-else' }),
      lake({ id: 'archived-lake', name: 'Old Lake', status: 'archived' }),
    ]);
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'org-lake', bytes: 2 }),
      group({ sourceType: FabFileSourceType.GITHUB, sourceLakeId: 'archived-lake', bytes: 1 }),
    ]);
    const result = await getUserStorageBreakdown(accessContext(), adapters);
    expect(result.buckets.map(b => b.lakeName)).toEqual([null, null]);
  });

  it('skips the lake lookup when no bucket names a lake', async () => {
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([group({ bytes: 1000 })]);
    const result = await getUserStorageBreakdown(accessContext(), adapters);
    expect(db.dataLakes.findByIds).not.toHaveBeenCalled();
    expect(result.unaccountedBytes).toBe(0);
  });

  it('throws NotFoundError for an unknown user', async () => {
    db.users.findById.mockResolvedValue(null);
    await expect(getUserStorageBreakdown(accessContext({ userId: 'missing' }), adapters)).rejects.toThrow(
      NotFoundError
    );
  });
});
