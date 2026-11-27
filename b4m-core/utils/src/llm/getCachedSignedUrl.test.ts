import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseStorage } from '@bike4mind/fab-pipeline';
import type { ICacheRepository } from '@bike4mind/common';
import { getCachedSignedUrl } from './utils';

describe('getCachedSignedUrl', () => {
  const signedAt = new Date('2026-01-02T03:04:05Z');

  afterEach(() => vi.useRealTimers());

  const setup = (signedUrl: string) => {
    const storage = { getSignedUrl: vi.fn().mockResolvedValue(signedUrl) } as unknown as BaseStorage;
    const caches = {
      findByKey: vi.fn().mockResolvedValue(null),
      createOrUpdate: vi.fn(),
    } as unknown as ICacheRepository;
    return { storage, caches };
  };

  it('caches a link only until the end its signer actually granted', async () => {
    vi.useFakeTimers({ now: signedAt });
    const clampedUrl = 'https://bucket.example.invalid/owned/file.png?X-Amz-Date=20260102T030405Z&X-Amz-Expires=600';
    const { storage, caches } = setup(clampedUrl);

    await expect(getCachedSignedUrl('owned/file.png', storage, { caches })).resolves.toBe(clampedUrl);

    expect(caches.createOrUpdate).toHaveBeenCalledWith({
      key: 'cachedSignedUrl:owned/file.png',
      result: clampedUrl,
      expiresAt: new Date(signedAt.getTime() + 600 * 1000),
    });
  });

  it('keeps the requested hour for a link without SigV4 params', async () => {
    vi.useFakeTimers({ now: signedAt });
    const { storage, caches } = setup('https://files.example.invalid/owned/file.png');

    await getCachedSignedUrl('owned/file.png', storage, { caches });

    expect(caches.createOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: new Date(signedAt.getTime() + 3600 * 1000) })
    );
  });
});
