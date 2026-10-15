import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FabFileSourceType } from '@bike4mind/common';
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

    const result = await getUserStorageBreakdown('user-1', adapters, { maxTimeMS: 1234 });

    expect(db.fabFiles.summarizeChargedStorageByUserId).toHaveBeenCalledWith('user-1', { maxTimeMS: 1234 });
    expect(db.dataLakes.findByIds).toHaveBeenCalledWith(['lake-a', 'lake-gone']);
    expect(result).toMatchObject({ totalBytes: 1000, accountedBytes: 950, unaccountedBytes: 50 });
    expect(result.buckets.map(b => [b.key, b.lakeName])).toEqual([
      ['google_drive:lake-a', 'Sales Drive'],
      ['manual_upload', undefined],
      ['github:lake-gone', null],
    ]);
  });

  it('withholds the name of a lake the caller did not create or that is not live', async () => {
    db.dataLakes.findByIds.mockResolvedValue([
      lake({ id: 'org-lake', name: 'Org Secrets', createdByUserId: 'someone-else' }),
      lake({ id: 'archived-lake', name: 'Old Lake', status: 'archived' }),
    ]);
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([
      group({ sourceType: FabFileSourceType.GOOGLE_DRIVE, sourceLakeId: 'org-lake', bytes: 2 }),
      group({ sourceType: FabFileSourceType.GITHUB, sourceLakeId: 'archived-lake', bytes: 1 }),
    ]);
    const result = await getUserStorageBreakdown('user-1', adapters);
    expect(result.buckets.map(b => b.lakeName)).toEqual([null, null]);
  });

  it('skips the lake lookup when no bucket names a lake', async () => {
    db.fabFiles.summarizeChargedStorageByUserId.mockResolvedValue([group({ bytes: 1000 })]);
    const result = await getUserStorageBreakdown('user-1', adapters);
    expect(db.dataLakes.findByIds).not.toHaveBeenCalled();
    expect(result.unaccountedBytes).toBe(0);
  });

  it('throws NotFoundError for an unknown user', async () => {
    db.users.findById.mockResolvedValue(null);
    await expect(getUserStorageBreakdown('missing', adapters)).rejects.toThrow(NotFoundError);
  });
});
