import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getSignedUrl } = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getPublishedArtifactsStorage: () => ({ getSignedUrl }),
}));

import {
  signOwnerThumbnailUrl,
  thumbnailSigningDate,
  THUMBNAIL_URL_TTL_SECONDS,
  THUMBNAIL_URL_WINDOW_SECONDS,
} from './thumbnailUrl';

const KEY = `publish-thumbnails/pub1/${'a'.repeat(64)}.webp`;

beforeEach(() => {
  vi.clearAllMocks();
  getSignedUrl.mockResolvedValue('https://signed.example.test/thumb');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('thumbnailSigningDate', () => {
  it('floors to the start of the 15-minute window', () => {
    expect(THUMBNAIL_URL_WINDOW_SECONDS).toBe(900);
    expect(thumbnailSigningDate(new Date('2026-03-04T05:14:59.999Z')).toISOString()).toBe('2026-03-04T05:00:00.000Z');
    expect(thumbnailSigningDate(new Date('2026-03-04T05:15:00.000Z')).toISOString()).toBe('2026-03-04T05:15:00.000Z');
  });
});

describe('signOwnerThumbnailUrl', () => {
  it('presigns a browser GET from the window start, valid for at least one more window', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-04T05:07:00.000Z') });
    await expect(signOwnerThumbnailUrl('pub1', KEY)).resolves.toBe('https://signed.example.test/thumb');
    expect(THUMBNAIL_URL_TTL_SECONDS).toBe(1800);
    expect(getSignedUrl).toHaveBeenCalledWith(KEY, 'get', {
      expiresIn: 1800,
      audience: 'browser',
      ResponseContentType: 'image/webp',
      signingDate: new Date('2026-03-04T05:00:00.000Z'),
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
