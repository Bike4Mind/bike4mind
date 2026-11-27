import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_LIST_REVISION_CACHE_KEY } from '@bike4mind/common';

const { findOne } = vi.hoisted(() => ({ findOne: vi.fn() }));
vi.mock('./models/infra/ops/CacheModel', () => ({ cacheRepository: { findOne } }));

const { readModelListRevision } = await import('./modelListRevision');

describe('readModelListRevision', () => {
  beforeEach(() => {
    findOne.mockReset();
  });

  it('reads the stamp off the revision cache row', async () => {
    findOne.mockResolvedValue({ key: MODEL_LIST_REVISION_CACHE_KEY, result: { revision: 'r1' } });

    await expect(readModelListRevision()).resolves.toBe('r1');
    expect(findOne).toHaveBeenCalledWith({ key: MODEL_LIST_REVISION_CACHE_KEY });
  });

  it('reads no row as no revision', async () => {
    findOne.mockResolvedValue(null);

    await expect(readModelListRevision()).resolves.toBeNull();
  });
});
