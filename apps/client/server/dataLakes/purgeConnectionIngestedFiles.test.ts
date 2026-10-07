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
const purge = () =>
  purgeConnectionIngestedFiles(LAKE, async () => FILES, { connectionId: 'conn1', label: 'Test', logger });

const file = (id: string) => ({ id, userId: 'u1', fileSize: 10, filePath: `p-${id}`, versions: [] });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('purgeConnectionIngestedFiles', () => {
  it('sweeps the files and recomputes lake stats', async () => {
    await expect(purge()).resolves.toEqual({ remaining: false });
    expect(h.purgeDataLakeConnectionFiles).toHaveBeenCalledWith(LAKE, FILES, expect.any(Object));
    expect(h.recomputeLakeStats).toHaveBeenCalled();
  });

  it('calls findFiles with no limit and reports nothing remaining when sliceSize is unset', async () => {
    const findFiles = vi.fn().mockResolvedValue(FILES);
    const result = await purgeConnectionIngestedFiles(LAKE, findFiles, {
      connectionId: 'conn1',
      label: 'Test',
      logger,
    });
    expect(findFiles).toHaveBeenCalledWith(undefined);
    expect(result).toEqual({ remaining: false });
  });

  it('sweeps only the first sliceSize files and reports remaining when more were found', async () => {
    const found = [file('f1'), file('f2'), file('f3')];
    const findFiles = vi.fn().mockResolvedValue(found);
    const result = await purgeConnectionIngestedFiles(LAKE, findFiles, {
      connectionId: 'conn1',
      label: 'Test',
      logger,
      sliceSize: 2,
    });
    expect(findFiles).toHaveBeenCalledWith(3);
    expect(h.purgeDataLakeConnectionFiles).toHaveBeenCalledWith(LAKE, found.slice(0, 2), expect.any(Object));
    expect(result).toEqual({ remaining: true });
  });

  it('reports nothing remaining when sliceSize covers every found file', async () => {
    const found = [file('f1'), file('f2')];
    const findFiles = vi.fn().mockResolvedValue(found);
    const result = await purgeConnectionIngestedFiles(LAKE, findFiles, {
      connectionId: 'conn1',
      label: 'Test',
      logger,
      sliceSize: 2,
    });
    expect(findFiles).toHaveBeenCalledWith(3);
    expect(h.purgeDataLakeConnectionFiles).toHaveBeenCalledWith(LAKE, found, expect.any(Object));
    expect(result).toEqual({ remaining: false });
  });

  it('logs and rethrows the purge error', async () => {
    const purgeError = new Error('storage blip');
    h.purgeDataLakeConnectionFiles.mockRejectedValue(purgeError);
    await expect(purge()).rejects.toBe(purgeError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), { ...ids, error: purgeError });
  });

  it('rethrows a finder failure without sweeping', async () => {
    const findError = new Error('find failed');
    await expect(
      purgeConnectionIngestedFiles(LAKE, () => Promise.reject(findError), {
        connectionId: 'conn1',
        label: 'Test',
        logger,
      })
    ).rejects.toBe(findError);
    expect(h.purgeDataLakeConnectionFiles).not.toHaveBeenCalled();
  });
});
