import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateSignedUrl, type GetFabFileAdapter } from './get';
import type { IFabFileDocument } from '@bike4mind/common';

function adapters(): GetFabFileAdapter {
  return {
    db: { fabFiles: {} as any, users: {} as any, adminSettings: {} as any },
    storage: { generateSignedUrl: vi.fn() },
  };
}

const fabFile = (over: Partial<IFabFileDocument> = {}) =>
  ({
    id: 'f1',
    moderationStatus: 'clean',
    supersededInLakes: [
      { dataLakeId: 'lake-1', supersededByFabFileId: 'winner-1', decidedByUserId: 'curator-1', decidedAt: new Date() },
    ],
    ...over,
  }) as IFabFileDocument;

describe('generateSignedUrl - curator ruling boundary', () => {
  it('strips supersededInLakes before a file reaches an outward-facing response', async () => {
    const result = await generateSignedUrl(fabFile(), adapters());
    expect(result.supersededInLakes).toBeUndefined();
  });

  it('strips it on the not-yet-serveable early return too', async () => {
    const result = await generateSignedUrl(fabFile({ moderationStatus: 'pending' }), adapters());
    expect(result.supersededInLakes).toBeUndefined();
  });
});

describe('generateSignedUrl - request-local signing', () => {
  afterEach(() => vi.unstubAllGlobals());

  const privateUrl = 'http://private.example.invalid/file';
  const browserUrl = 'https://public.example.invalid/file';
  const cachedFile = () =>
    fabFile({
      filePath: 'owned/file.txt',
      fileUrl: privateUrl,
      fileUrlExpireAt: new Date(Date.now() + 3600000),
    });
  const browserAdapter = () => {
    const adapter = adapters();
    Object.assign(adapter.storage, { signedUrlCache: 'bypass' });
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(browserUrl);
    adapter.db.fabFiles.update = vi.fn();
    return adapter;
  };

  it('signs a fresh browser response without reading or persisting the private cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const original = cachedFile();
    const before = { ...original };
    const adapter = browserAdapter();
    const browser = await generateSignedUrl(original, adapter);
    expect(browser.fileUrl).toBe(browserUrl);
    expect(adapter.storage.generateSignedUrl).toHaveBeenCalledWith('owned/file.txt', 3600);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(original).toEqual(before);
    const serverAdapter = adapters();
    const server = await generateSignedUrl(original, serverAdapter);
    expect(server.fileUrl).toBe(privateUrl);
    expect(fetchMock).toHaveBeenCalledWith(privateUrl, { method: 'GET' });
    expect(serverAdapter.storage.generateSignedUrl).not.toHaveBeenCalled();
  });

  it.each(['missing-path', 'signing-unavailable'])('withholds the cached private URL on %s', async failure => {
    const adapter = browserAdapter();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(null);
    const original = cachedFile();
    if (failure === 'missing-path') original.filePath = undefined;
    const result = await generateSignedUrl(original, adapter);
    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    expect(original.fileUrl).toBe(privateUrl);
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('retains default private cache refresh and moderation withholding', async () => {
    const adapter = adapters();
    adapter.db.fabFiles.update = vi.fn();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(privateUrl);
    const result = await generateSignedUrl(fabFile({ filePath: 'owned/file.txt' }), adapter);
    expect(result.fileUrl).toBe(privateUrl);
    expect(adapter.db.fabFiles.update).toHaveBeenCalledWith(
      { id: 'f1', fileUrl: privateUrl, fileUrlExpireAt: expect.any(Date) },
      { timestamps: false }
    );
    const browser = browserAdapter();
    const held = await generateSignedUrl(fabFile({ ...cachedFile(), moderationStatus: 'pending' }), browser);
    expect(held.fileUrl).toBeUndefined();
    expect(browser.storage.generateSignedUrl).not.toHaveBeenCalled();
    expect(browser.db.fabFiles.update).not.toHaveBeenCalled();
  });
});
