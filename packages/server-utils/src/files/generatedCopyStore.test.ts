import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storageDelete: vi.fn(),
  findSessionIdsByMedia: vi.fn(),
  findAllByIds: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: { findSessionIdsByMedia: h.findSessionIdsByMedia },
  sessionRepository: { findAllByIds: h.findAllByIds },
}));
vi.mock('../utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: h.storageDelete }),
}));

import { getGeneratedCopyStore } from './generatedCopyStore';

beforeEach(() => {
  vi.resetAllMocks();
  h.storageDelete.mockResolvedValue(undefined);
});

describe('getGeneratedCopyStore', () => {
  it('deletes the copy from the generated bucket', async () => {
    await getGeneratedCopyStore().storage.delete('copy-1.png');

    expect(h.storageDelete).toHaveBeenCalledWith('copy-1.png');
  });

  it('surfaces a storage delete failure', async () => {
    h.storageDelete.mockRejectedValue(new Error('s3 down'));

    await expect(getGeneratedCopyStore().storage.delete('copy-1.png')).rejects.toThrow('s3 down');
  });

  it('counts only live notebooks as still showing a copy', async () => {
    h.findSessionIdsByMedia.mockResolvedValue(['deleted-fork', 'live-fork']);
    h.findAllByIds.mockResolvedValue([{ id: 'live-fork' }]);

    const ids = await getGeneratedCopyStore().quests.findSessionIdsByMedia('copy-1.png');

    expect(h.findAllByIds).toHaveBeenCalledWith(['deleted-fork', 'live-fork']);
    expect(ids).toEqual(['live-fork']);
  });

  it('skips the session lookup when no reply shows the copy', async () => {
    h.findSessionIdsByMedia.mockResolvedValue([]);

    expect(await getGeneratedCopyStore().quests.findSessionIdsByMedia('copy-1.png')).toEqual([]);
    expect(h.findAllByIds).not.toHaveBeenCalled();
  });
});
