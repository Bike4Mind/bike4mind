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
      activateIfDraft: vi.fn().mockResolvedValue(true),
    },
    fabFiles: {
      computeDataLakeStats: vi.fn().mockResolvedValue({ fileCount, totalSizeBytes: fileCount * 100 }),
    },
  },
});

describe('recomputeLakeStats draft activation', () => {
  it('activates the lake once it holds a member file', async () => {
    const adapters = makeAdapters(1);

    await recomputeLakeStats(lake, adapters);

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 1, totalSizeBytes: 100 });
    expect(adapters.db.dataLakes.activateIfDraft).toHaveBeenCalledWith('lake1');
  });

  it('leaves an empty lake in draft', async () => {
    const adapters = makeAdapters(0);

    await recomputeLakeStats(lake, adapters);

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 0, totalSizeBytes: 0 });
    expect(adapters.db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
  });

  it('still returns the stats it computed', async () => {
    expect(await recomputeLakeStats(lake, makeAdapters(3))).toEqual({ fileCount: 3, totalSizeBytes: 300 });
  });

  it('skipActivation still corrects stats but never activates, even with member files', async () => {
    const adapters = makeAdapters(1);

    await recomputeLakeStats(lake, adapters, { skipActivation: true });

    expect(adapters.db.dataLakes.setStats).toHaveBeenCalledWith('lake1', { fileCount: 1, totalSizeBytes: 100 });
    expect(adapters.db.dataLakes.activateIfDraft).not.toHaveBeenCalled();
  });

  it('activates normally when skipActivation is omitted or false', async () => {
    const adapters = makeAdapters(1);

    await recomputeLakeStats(lake, adapters, { skipActivation: false });

    expect(adapters.db.dataLakes.activateIfDraft).toHaveBeenCalledWith('lake1');
  });
});
