import { describe, it, expect, vi } from 'vitest';
import { makeBundleFileSigner, resolveBundleDownload } from './resolveBundleDownload';

const ORIGIN = 'https://bucket.example.test';
const DOC_ORIGIN = 'https://app.example.test';

const makeStorage = (overrides: Record<string, unknown> = {}) => ({
  browserSigningOrigin: vi.fn(async () => ORIGIN),
  getSignedUrl: vi.fn(async (key: string) => `${ORIGIN}/${key}?sig=1`),
  ...overrides,
});
type Storage = Parameters<typeof resolveBundleDownload>[0]['storage'];

const artifact = {
  storageKeyPrefix: 'published/pub1/',
  indexObjectPath: null,
  manifest: [{ path: 'index.html' }, { path: 'data/report.csv' }],
};

describe('resolveBundleDownload', () => {
  it('signs the asset as an attachment under the bundle prefix', async () => {
    const storage = makeStorage();
    const result = await resolveBundleDownload({
      storage: storage as unknown as Storage,
      artifact,
      assetPath: 'data/report.csv',
      docOrigin: DOC_ORIGIN,
    });
    expect(result).toEqual({
      key: 'published/pub1/data/report.csv',
      disposition: 'attachment',
      url: `${ORIGIN}/published/pub1/data/report.csv?sig=1`,
    });
    expect(storage.getSignedUrl).toHaveBeenCalledWith(
      'published/pub1/data/report.csv',
      'get',
      expect.objectContaining({
        audience: 'browser',
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: expect.stringContaining('attachment'),
      })
    );
  });

  it('throws 404 asset_not_found for a path outside the manifest', async () => {
    await expect(
      resolveBundleDownload({
        storage: makeStorage() as unknown as Storage,
        artifact,
        assetPath: 'secret.txt',
        docOrigin: DOC_ORIGIN,
      })
    ).rejects.toMatchObject({ statusCode: 404, additionalInfo: { errorCode: 'asset_not_found' } });
  });

  it('throws 503 download_unavailable when storage cannot sign for browsers', async () => {
    await expect(
      resolveBundleDownload({
        storage: makeStorage({ browserSigningOrigin: undefined }) as unknown as Storage,
        artifact,
        assetPath: 'data/report.csv',
        docOrigin: DOC_ORIGIN,
      })
    ).rejects.toMatchObject({ statusCode: 503, additionalInfo: { errorCode: 'download_unavailable' } });
  });
});

describe('makeBundleFileSigner', () => {
  it('refuses a link that lands on the app origin', async () => {
    const storage = makeStorage({ browserSigningOrigin: vi.fn(async () => DOC_ORIGIN) });
    const sign = makeBundleFileSigner(storage as unknown as Storage, artifact, DOC_ORIGIN);
    expect(await sign('data/report.csv', true, 60)).toBeNull();
    expect(await sign.origin()).toBe('');
  });

  it('looks the signing origin up once per signer', async () => {
    const storage = makeStorage();
    const sign = makeBundleFileSigner(storage as unknown as Storage, artifact, DOC_ORIGIN);
    await sign('data/report.csv', true, 60);
    await sign('data/report.csv', false, 60);
    expect(storage.browserSigningOrigin).toHaveBeenCalledTimes(1);
  });
});
