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

describe('generateSignedUrl - sign on read, never persisted', () => {
  const storedUrl = 'https://stored.example.invalid/file';
  const freshUrl = 'https://fresh.example.invalid/file';
  const legacyFile = (over: Partial<IFabFileDocument> = {}) =>
    fabFile({
      filePath: 'owned/file.txt',
      fileUrl: storedUrl,
      fileUrlExpireAt: new Date(Date.now() + 3600000),
      ...over,
    });
  const signingAdapter = () => {
    const adapter = adapters();
    adapter.db.fabFiles.update = vi.fn();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(freshUrl);
    return adapter;
  };

  it('ignores a stored URL and never writes the row', async () => {
    const original = legacyFile();
    const before = { ...original };
    const adapter = signingAdapter();
    const result = await generateSignedUrl(original, adapter);
    expect(result.fileUrl).toBe(freshUrl);
    expect(adapter.storage.generateSignedUrl).toHaveBeenCalledWith('owned/file.txt', 3600, {
      signingDate: expect.any(Date),
    });
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
    expect(original).toEqual(before);
  });

  it.each(['missing-path', 'signing-unavailable'])('withholds the stored URL on %s', async failure => {
    const adapter = signingAdapter();
    vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(null);
    const original = legacyFile();
    if (failure === 'missing-path') original.filePath = undefined;
    const result = await generateSignedUrl(original, adapter);
    expect(result.fileUrl).toBeUndefined();
    expect(result.fileUrlExpireAt).toBeUndefined();
    expect(adapter.db.fabFiles.update).not.toHaveBeenCalled();
  });

  it('withholds the URL for a held image without signing', async () => {
    const adapter = signingAdapter();
    const held = await generateSignedUrl(legacyFile({ moderationStatus: 'pending' }), adapter);
    expect(held.fileUrl).toBeUndefined();
    expect(adapter.storage.generateSignedUrl).not.toHaveBeenCalled();
  });

  describe('windowed signing', () => {
    afterEach(() => vi.useRealTimers());

    it('requests the same signing date for every read inside one window', async () => {
      const adapter = signingAdapter();
      vi.useFakeTimers({ now: new Date('2026-01-02T03:04:05Z') });
      await generateSignedUrl(legacyFile(), adapter);
      vi.setSystemTime(new Date('2026-01-02T03:29:59Z'));
      await generateSignedUrl(legacyFile(), adapter);
      vi.setSystemTime(new Date('2026-01-02T03:30:00Z'));
      await generateSignedUrl(legacyFile(), adapter);
      const dates = vi.mocked(adapter.storage.generateSignedUrl).mock.calls.map(c => c[2]?.signingDate?.toISOString());
      expect(dates).toEqual(['2026-01-02T03:00:00.000Z', '2026-01-02T03:00:00.000Z', '2026-01-02T03:30:00.000Z']);
    });
  });

  it('stamps expiry from the window start, not the read time', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-02T03:10:00Z') });
    try {
      const adapter = adapters();
      vi.mocked(adapter.storage.generateSignedUrl).mockImplementation(
        async (_path, expires, options) =>
          `https://bucket.example.invalid/f?X-Amz-Date=${options!.signingDate!.toISOString().replace(/[-:]|\.\d{3}/g, '')}&X-Amz-Expires=${expires}`
      );
      const result = await generateSignedUrl(fabFile({ filePath: 'owned/file.txt' }), adapter);
      expect(result.fileUrlExpireAt).toEqual(new Date('2026-01-02T04:00:00Z'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives the response expiry from the signed URL', async () => {
    const signedAt = new Date('2026-01-02T03:04:05Z');
    vi.useFakeTimers({ now: signedAt });
    try {
      const adapter = adapters();
      const url = 'https://bucket.example.invalid/f?X-Amz-Date=20260102T030405Z&X-Amz-Expires=1140';
      vi.mocked(adapter.storage.generateSignedUrl).mockResolvedValue(url);
      const result = await generateSignedUrl(fabFile({ filePath: 'owned/file.txt' }), adapter);
      expect(result.fileUrlExpireAt).toEqual(new Date(signedAt.getTime() + 19 * 60 * 1000));
    } finally {
      vi.useRealTimers();
    }
  });
});
