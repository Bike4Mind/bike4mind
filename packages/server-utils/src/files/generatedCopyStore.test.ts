import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storageDelete: vi.fn(),
  findSessionIdsByMedia: vi.fn(),
  findAllByIds: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: { findSessionIdsByMedia: h.findSessionIdsByMedia },
  sessionRepository: { findAllByIds: h.findAllByIds },
}));
vi.mock('../utils/storage/index', () => ({
  getGeneratedImageStorage: () => ({ delete: h.storageDelete }),
}));
vi.mock('../services/cdn/invalidateRouterCdn', async importActual => ({
  ...(await importActual<typeof import('../services/cdn/invalidateRouterCdn')>()),
  invalidateRouterPaths: h.invalidate,
}));

import { getGeneratedCopyStore } from './generatedCopyStore';

beforeEach(() => {
  vi.resetAllMocks();
  h.storageDelete.mockResolvedValue(undefined);
  h.invalidate.mockResolvedValue(undefined);
});

describe('getGeneratedCopyStore', () => {
  it('invalidates the deleted copy right away when no batch is given', async () => {
    await getGeneratedCopyStore().storage.delete('copy-1.png');

    expect(h.storageDelete).toHaveBeenCalledWith('copy-1.png');
    expect(h.invalidate).toHaveBeenCalledWith(['/generated/copy-1.png'], expect.objectContaining({}));
    expect(h.storageDelete.mock.invocationCallOrder[0]).toBeLessThan(h.invalidate.mock.invocationCallOrder[0]);
  });

  it('queues the path on the caller batch instead of invalidating per copy', async () => {
    const batch = { add: vi.fn(), flush: vi.fn() };
    const store = getGeneratedCopyStore({ batch });
    await store.storage.delete('copy-1.png');
    await store.storage.delete('copy-2.png');

    expect(batch.add.mock.calls).toEqual([['/generated/copy-1.png'], ['/generated/copy-2.png']]);
    expect(batch.flush).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('invalidates nothing when the storage delete fails', async () => {
    h.storageDelete.mockRejectedValue(new Error('s3 down'));
    const batch = { add: vi.fn(), flush: vi.fn() };

    await expect(getGeneratedCopyStore({ batch }).storage.delete('copy-1.png')).rejects.toThrow('s3 down');
    expect(batch.add).not.toHaveBeenCalled();
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
