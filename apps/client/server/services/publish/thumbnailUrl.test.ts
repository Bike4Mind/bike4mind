import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSignedUrl } = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ getSignedUrl }),
}));

import { signOwnerThumbnailUrl, THUMBNAIL_URL_TTL_SECONDS } from './thumbnailUrl';

const KEY = `publish-thumbnails/pub1/${'a'.repeat(64)}.webp`;

beforeEach(() => {
  vi.clearAllMocks();
  getSignedUrl.mockResolvedValue('https://signed.example.test/thumb');
});

describe('signOwnerThumbnailUrl', () => {
  it('presigns a 15-minute browser GET for the artifact own thumbnail', async () => {
    await expect(signOwnerThumbnailUrl('pub1', KEY)).resolves.toBe('https://signed.example.test/thumb');
    expect(THUMBNAIL_URL_TTL_SECONDS).toBe(900);
    expect(getSignedUrl).toHaveBeenCalledWith(KEY, 'get', {
      expiresIn: 900,
      audience: 'browser',
      ResponseContentType: 'image/webp',
    });
  });

  it.each([
    ['another artifact thumbnail', `publish-thumbnails/pub2/${'a'.repeat(64)}.webp`],
    ['a bundle file', 'user/owner1/my-slug/index.html'],
    ['a traversal', `publish-thumbnails/pub1/../pub2/${'a'.repeat(64)}.webp`],
  ])('refuses to sign %s', async (_label, key) => {
    await expect(signOwnerThumbnailUrl('pub1', key)).resolves.toBeUndefined();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('degrades to undefined when signing fails', async () => {
    getSignedUrl.mockRejectedValue(new Error('no credentials'));
    await expect(signOwnerThumbnailUrl('pub1', KEY)).resolves.toBeUndefined();
  });
});
