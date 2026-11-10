// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSignedUrl = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl }),
}));

import { extractModalImageKey, modalImageAppUrl, resolveModalImageUrl, withSignedModalImage } from './modalImageUrls';

beforeEach(() => {
  vi.clearAllMocks();
  getSignedUrl.mockResolvedValue('https://signed.example/modal-images/a.png?X-Amz-Algorithm=AWS4&X-Amz-Signature=x');
});

describe('extractModalImageKey', () => {
  it('accepts a bare key and a presigned URL for one', () => {
    expect(extractModalImageKey('modal-images/a.png')).toBe('modal-images/a.png');
    expect(
      extractModalImageKey('https://b.s3.amazonaws.com/modal-images/a.png?X-Amz-Algorithm=AWS4&X-Amz-Signature=x')
    ).toBe('modal-images/a.png');
  });

  it('rejects external URLs and other S3 objects', () => {
    expect(extractModalImageKey('https://cdn.example.com/banner.png')).toBeNull();
    expect(extractModalImageKey('https://b.s3.amazonaws.com/proxied-images/a.png')).toBeNull();
    expect(extractModalImageKey('https://cdn.example.com/modal-images/a.png')).toBeNull();
    expect(
      extractModalImageKey('https://b.s3.amazonaws.com/modal-images/%ZZ?X-Amz-Algorithm=AWS4&X-Amz-Signature=x')
    ).toBeNull();
    expect(extractModalImageKey(null)).toBeNull();
  });
});

describe('resolveModalImageUrl', () => {
  it('signs a stored key with an expiry of at most one hour', async () => {
    const url = await resolveModalImageUrl('modal-images/a.png');

    expect(url).toContain('X-Amz-Signature');
    expect(getSignedUrl).toHaveBeenCalledWith('modal-images/a.png', 'get', {
      audience: 'browser',
      expiresIn: 3600,
    });
  });

  it('passes external URLs and empty values through without signing', async () => {
    expect(await resolveModalImageUrl('https://cdn.example.com/banner.png')).toBe('https://cdn.example.com/banner.png');
    expect(await resolveModalImageUrl(null)).toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('withSignedModalImage', () => {
  it('replaces imageUrl and leaves other fields alone', async () => {
    const out = await withSignedModalImage({ title: 't', imageUrl: 'modal-images/a.png' });
    expect(out.title).toBe('t');
    expect(out.imageUrl).toContain('X-Amz-Signature');
  });
});

describe('modalImageAppUrl', () => {
  it('maps a stored key to the stable app route and leaves other values alone', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    expect(modalImageAppUrl('modal-images/a.png')).toBe('https://app.example.com/api/modal-images/a.png');
    expect(modalImageAppUrl('https://cdn.example.com/banner.png')).toBe('https://cdn.example.com/banner.png');
    expect(modalImageAppUrl(null)).toBeNull();
    vi.stubEnv('APP_URL', 'https://app.example.com///');
    expect(modalImageAppUrl('modal-images/a.png')).toBe('https://app.example.com/api/modal-images/a.png');
    vi.stubEnv('APP_URL', '');
    expect(() => modalImageAppUrl('modal-images/a.png')).toThrow('APP_URL');
    vi.unstubAllEnvs();
  });
});
