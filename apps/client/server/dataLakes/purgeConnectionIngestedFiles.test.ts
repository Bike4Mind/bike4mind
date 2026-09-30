import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  purgeDataLakeConnectionFiles: vi.fn(),
  recomputeLakeStats: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeFindingRepository: {},
  dataLakeRepository: {},
  fabFileChunkRepository: {},
  fabFileRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    purgeDataLakeConnectionFiles: h.purgeDataLakeConnectionFiles,
    lakeMembershipScope: (lake: unknown) => lake,
    openSearchRetrievalIndex: vi.fn(),
    recomputeLakeStats: h.recomputeLakeStats,
  },
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ FabFileChunkSearchIndex: {} }));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/dataLakes/shredMemoryForLakeTags', () => ({ shredMemoryForLakeTags: vi.fn() }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ delete: vi.fn() }) }));

import { purgeConnectionIngestedFiles } from './purgeConnectionIngestedFiles';

const LAKE = { id: 'lake1', datalakeTag: 'datalake:lake1', createdByUserId: 'u1' } as never;
const FILES = [{ id: 'f1', userId: 'u1', fileSize: 10, filePath: 'p1', versions: [] }] as never;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ids = { connectionId: 'conn1', dataLakeId: 'lake1' };
const purge = (restore?: () => Promise<unknown>) =>
  purgeConnectionIngestedFiles(LAKE, async () => FILES, { connectionId: 'conn1', label: 'Test', logger, restore });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('purgeConnectionIngestedFiles', () => {
  it('sweeps the files and recomputes lake stats without restoring', async () => {
    const restore = vi.fn();
    await purge(restore);
    expect(h.purgeDataLakeConnectionFiles).toHaveBeenCalledWith(LAKE, FILES, expect.any(Object));
    expect(h.recomputeLakeStats).toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('rethrows the purge error, not the restore error, and logs both', async () => {
    const purgeError = new Error('storage blip');
    const restoreError = new Error('mongo down');
    h.purgeDataLakeConnectionFiles.mockRejectedValue(purgeError);
    const restore = vi.fn().mockRejectedValue(restoreError);
    await expect(purge(restore)).rejects.toBe(purgeError);
    expect(restore).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { ...ids, error: purgeError });
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { ...ids, restoreError });
  });

  it('restores on a finder failure too', async () => {
    const findError = new Error('find failed');
    const restore = vi.fn();
    await expect(
      purgeConnectionIngestedFiles(LAKE, () => Promise.reject(findError), {
        connectionId: 'conn1',
        label: 'Test',
        logger,
        restore,
      })
    ).rejects.toBe(findError);
    expect(restore).toHaveBeenCalled();
    expect(h.purgeDataLakeConnectionFiles).not.toHaveBeenCalled();
  });
});
