import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { recomputeLakeStats } from './recomputeLakeStats';

const lake = {
  id: 'lake1',
  datalakeTag: 'datalake:lake',
  fileTagPrefix: 'lake:',
  createdByUserId: 'owner',
} as Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>;

const makeAdapters = (fileCount: number) => ({
  db: {
    dataLakes: {
      setStats: vi.fn().mockResolvedValue(null),
    },
    fabFiles: {
      computeDataLakeStats: vi
        .fn()
        .mockResolvedValue({ fileCount, totalSizeBytes: fileCount * 100, totalChunkedChars: 0 }),
    },
  },
});

// draft -> active is no longer a side effect of this function - see `promoteDataLake`,
// the explicit, authorized, audited door that replaced the old implicit flip.
describe('recomputeLakeStats', () => {
  it('persists the recomputed stats regardless of the lake carrying files or not', async () => {
    const adapters = makeAdapters(1);

    await recomputeLakeStats(lake, adapters);

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 1,
      totalSizeBytes: 100,
      totalChunkedChars: 0,
    });
  });

  it("leaves an empty lake's stats at zero", async () => {
    const adapters = makeAdapters(0);

    await recomputeLakeStats(lake, adapters);

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', {
      fileCount: 0,
      totalSizeBytes: 0,
      totalChunkedChars: 0,
    });
  });

  it('returns the stats it computed', async () => {
    expect(await recomputeLakeStats(lake, makeAdapters(3))).toEqual({
      fileCount: 3,
      totalSizeBytes: 300,
      totalChunkedChars: 0,
    });
  });

  it('never touches lake status, even when the lake holds member files', async () => {
    const adapters = makeAdapters(1) as ReturnType<typeof makeAdapters> & {
      db: { dataLakes: { activateIfDraft?: unknown; demoteToDraft?: unknown } };
    };

    await recomputeLakeStats(lake, adapters);

    expect(adapters.db.dataLakes.activateIfDraft).toBeUndefined();
    expect(adapters.db.dataLakes.demoteToDraft).toBeUndefined();
  });

  it("accepts an unused logger, so every existing call site's `{ db, logger }` literal still compiles", async () => {
    const adapters = makeAdapters(1);
    const logger = { warn: vi.fn(), error: vi.fn() };

    await recomputeLakeStats(lake, { ...adapters, logger });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
