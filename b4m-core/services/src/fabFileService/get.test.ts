import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
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

describe('generateSignedUrl - hydrated Mongoose document', () => {
  // findAllAccessibleByIds (byIds, list) hands over hydrated docs, whose fields live on the
  // prototype: a spread copies only _doc/$__, so the response lost id and moderationStatus.
  const schema = new mongoose.Schema(
    { fileName: String, mimeType: String, filePath: String, moderationStatus: String },
    { toJSON: { virtuals: true, transform: (_doc, ret) => void (ret.id = ret._id.toString()) } }
  );
  const Model = mongoose.models.GetFabFileHydratedTest || mongoose.model('GetFabFileHydratedTest', schema);
  const hydrated = (moderationStatus: string) =>
    new Model({
      fileName: 'paste.png',
      mimeType: 'image/png',
      filePath: 'p.png',
      moderationStatus,
    }) as unknown as IFabFileDocument;

  it('returns the fields top-level, without Mongoose internals', async () => {
    const doc = hydrated('clean');
    const adapter = adapters();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue('https://signed.example.invalid/p.png');
    adapter.db.fabFiles.update = vi.fn();
    const result = await generateSignedUrl(doc, adapter);
    expect(result).toMatchObject({ id: doc.id, moderationStatus: 'clean', fileName: 'paste.png' });
    expect(result.fileUrl).toBe('https://signed.example.invalid/p.png');
    expect(result).not.toHaveProperty('_doc');
    expect(result).not.toHaveProperty('$__');
  });

  it('keeps a pending image recognisable as pending', async () => {
    const result = await generateSignedUrl(hydrated('pending'), adapters());
    expect(result).toMatchObject({ moderationStatus: 'pending', fileUrl: undefined });
    expect(result).not.toHaveProperty('_doc');
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
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('generateSignedUrl - cached URL reuse', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cachedUrl = 'https://cached.example.invalid/file';
  const freshUrl = 'https://fresh.example.invalid/file';
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60 * 1000);
  const signingAdapter = () => {
    const adapter = adapters();
    adapter.db.fabFiles.update = vi.fn();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(freshUrl);
    return adapter;
  };

  // 6 min here and 4 min below sit either side of the 5-minute refresh margin, pinning it.
  it('reuses an unexpired cached URL without fetching the object', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const adapter = signingAdapter();
    const result = await generateSignedUrl(
      fabFile({ filePath: 'owned/file.txt', fileUrl: cachedUrl, fileUrlExpireAt: minutesFromNow(6) }),
      adapter
    );
    expect(result.fileUrl).toBe(cachedUrl);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(adapter.storage.generateSignedUrl).not.toHaveBeenCalled();
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', -1],
    ['about to expire', 4],
  ])('re-signs a cached URL that is %s', async (_label, minutes) => {
    const adapter = signingAdapter();
    const result = await generateSignedUrl(
      fabFile({ filePath: 'owned/file.txt', fileUrl: cachedUrl, fileUrlExpireAt: minutesFromNow(minutes) }),
      adapter
    );
    expect(result.fileUrl).toBe(freshUrl);
    expect(adapter.db.fabFiles.update).toHaveBeenCalledWith(
      { id: 'f1', fileUrl: freshUrl, fileUrlExpireAt: expect.any(Date) },
      { timestamps: false }
    );
  });
});

describe('generateSignedUrl - derived cache expiry', () => {
  const signedAt = new Date('2026-01-02T03:04:05Z');
  const sigV4Url = (expiresSeconds: number) =>
    `https://bucket.example.invalid/owned/file.txt?X-Amz-Date=20260102T030405Z&X-Amz-Expires=${expiresSeconds}`;

  afterEach(() => vi.useRealTimers());

  it('persists the clamped expiry on the FabFile row', async () => {
    vi.useFakeTimers({ now: signedAt });
    const adapter = adapters();
    adapter.db.fabFiles.update = vi.fn();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(sigV4Url(19 * 60));
    const clampedExpiry = new Date(signedAt.getTime() + 19 * 60 * 1000);

    const result = await generateSignedUrl(fabFile({ filePath: 'owned/file.txt' }), adapter);

    expect(result.fileUrlExpireAt).toEqual(clampedExpiry);
    expect(adapter.db.fabFiles.update).toHaveBeenCalledWith(
      { id: 'f1', fileUrl: sigV4Url(19 * 60), fileUrlExpireAt: clampedExpiry },
      { timestamps: false }
    );
  });
});
