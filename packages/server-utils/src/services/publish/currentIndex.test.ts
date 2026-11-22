import { describe, expect, it, vi } from 'vitest';
import { currentPublishedIndexKey, deleteRetiredPublishedIndex, downloadPublishedIndex } from './currentIndex';

const prefix = 'user/owner/page/';
const path = 'revisions/11111111-1111-4111-8111-111111111111/index.html';
const sha = 'a'.repeat(64);
const snapshot = { storageKeyPrefix: prefix, indexObjectPath: path, sha256Index: sha };

describe('published index snapshots', () => {
  it('retains legacy paths and rejects pointers outside an owned revision', () => {
    expect(currentPublishedIndexKey({ storageKeyPrefix: prefix })).toBe(`${prefix}index.html`);
    expect(() => currentPublishedIndexKey({ ...snapshot, indexObjectPath: '../foreign/index.html' })).toThrow();
  });

  it('loads the observed version if a concurrent confirmed switch retires its payload before download', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = Buffer.from('OBSERVED_VERSION');
    const objects = new Map([[`${prefix}${path}`, original]]);
    const storage = {
      download: async (key: string): Promise<Buffer> => {
        if (key === `${prefix}${path}`) {
          entered.resolve();
          await release.promise;
        }
        const bytes = objects.get(key);
        if (!bytes) throw new Error('Object missing');
        return bytes;
      },
      delete: async (key: string): Promise<void> => {
        objects.delete(key);
      },
    };
    const read = downloadPublishedIndex(snapshot, storage);
    try {
      await entered.promise;
      objects.set(`${prefix}versions/${sha}.html`, original);
      await deleteRetiredPublishedIndex(snapshot, storage, error => {
        throw error;
      });
      release.resolve();
      await expect(read).resolves.toEqual(original);
    } finally {
      release.resolve();
      await Promise.allSettled([read]);
    }
  });

  it('retains the original storage failure if neither payload nor archive can be loaded', async () => {
    const original = new Error('current object missing');
    const download = vi.fn().mockRejectedValueOnce(original).mockRejectedValueOnce(new Error('archive missing'));
    await expect(downloadPublishedIndex(snapshot, { download })).rejects.toBe(original);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('never deletes a legacy canonical object and reports retirement failure explicitly', async () => {
    const error = new Error('delete unavailable');
    const storage = { delete: vi.fn().mockRejectedValue(error) };
    const warn = vi.fn();
    await deleteRetiredPublishedIndex({ storageKeyPrefix: prefix }, storage, warn);
    expect(storage.delete).not.toHaveBeenCalled();
    await deleteRetiredPublishedIndex(snapshot, storage, warn);
    expect(storage.delete).toHaveBeenCalledWith(`${prefix}${path}`);
    expect(warn).toHaveBeenCalledWith(error);
  });
});
