import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  findById: vi.fn(),
  updateOne: vi.fn(),
  download: vi.fn(),
  downloadRange: vi.fn(),
  moderateUploadedFile: vi.fn(),
  getMetadata: vi.fn(),
  getSettingsValue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { findById: h.findById, findOneAndUpdate: h.findOneAndUpdate, updateOne: h.updateOne },
  adminSettingsRepository: {},
  imageModerationIncidentRepository: {},
}));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: h.getSettingsValue,
}));
vi.mock('@bike4mind/utils/imageModeration', () => ({ RekognitionImageModerationService: class {} }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ download: h.download, downloadRange: h.downloadRange, getMetadata: h.getMetadata }),
}));
vi.mock('@bike4mind/server-utils/s3/moderateUploadedFile', () => ({ moderateUploadedFile: h.moderateUploadedFile }));

import {
  claimModerationScan,
  normalizeETag,
  recordLandedObject,
  releaseModerationClaim,
  scanUploadedObject,
  toVerdictPatch,
  writeModerationVerdict,
} from './moderationScan';

const claimedAt = new Date('2026-10-13T00:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('recordLandedObject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findById.mockReturnValue({ select: () => ({ lean: async () => ({ moderationETag: 'etag-b' }) }) });
    h.getMetadata.mockResolvedValue({ etag: '"etag-b"' });
    h.updateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it('uses current storage truth for a delayed event and preserves the current terminal verdict', async () => {
    await recordLandedObject('ff1', 'uploads/f.png');
    expect(h.getMetadata).toHaveBeenCalledWith('uploads/f.png');
    expect(h.updateOne).not.toHaveBeenCalled();
    expect(h.findById.mock.invocationCallOrder[0]).toBeLessThan(h.getMetadata.mock.invocationCallOrder[0]);
  });

  it('compares-and-sets the observed row before resetting a genuine overwrite', async () => {
    h.getMetadata.mockResolvedValue({ etag: '"etag-c"' });
    await recordLandedObject('ff1', 'uploads/f.png');
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'ff1', moderationETag: 'etag-b', moderationRevision: null },
      expect.any(Array)
    );
    expect(h.updateOne.mock.calls[0][1][0].$set.moderationETag).toBe('etag-c');
  });

  it('retries a failed HEAD without changing the verdict', async () => {
    h.getMetadata.mockRejectedValueOnce(new Error('head unavailable'));
    await expect(recordLandedObject('ff1', 'uploads/f.png')).rejects.toThrow('head unavailable');
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it.each([undefined, null, ''])('retries a missing ETag %j without changing the verdict', async etag => {
    h.getMetadata.mockResolvedValue({ etag });
    await expect(recordLandedObject('ff1', 'uploads/f.png')).rejects.toThrow('No ETag');
    expect(h.updateOne).not.toHaveBeenCalled();
  });

  it('retries when another reconciliation changed the observed version during HEAD', async () => {
    h.getMetadata.mockResolvedValue({ etag: 'etag-a' });
    h.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(recordLandedObject('ff1', 'uploads/f.png')).rejects.toThrow('retry the landing');
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'ff1', moderationETag: 'etag-b', moderationRevision: null },
      expect.any(Array)
    );
  });
});

describe('moderationScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.updateOne.mockResolvedValue({ matchedCount: 1 });
    h.getSettingsValue.mockReturnValue(undefined);
    h.moderateUploadedFile.mockResolvedValue({ moderationStatus: 'clean' });
  });

  it('compares HeadObject (quoted) and S3 event (bare) ETags in one form, multipart suffix kept', () => {
    expect(normalizeETag('"abc-3"')).toBe('abc-3');
    expect(normalizeETag('abc-3')).toBe('abc-3');
    expect(normalizeETag('')).toBeUndefined();
    expect(normalizeETag(undefined)).toBeUndefined();
  });

  it('claims only a pending or unset file, stamping the claim identity', async () => {
    await claimModerationScan('ff1', claimedAt);

    expect(h.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'ff1', moderationStatus: { $in: ['pending', null] } },
      { $set: { moderationStatus: 'scanning', moderationClaimedAt: claimedAt } },
      { new: true }
    );
  });

  it('writes a verdict only while the claim stamp still matches, and reports whether it landed', async () => {
    const patch = { moderationStatus: 'clean' as const };

    await expect(writeModerationVerdict('ff1', claimedAt, patch)).resolves.toBe(true);
    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'ff1', moderationStatus: 'scanning', moderationClaimedAt: claimedAt },
      { $set: patch, $unset: { moderationClaimedAt: 1 } },
      { session: undefined }
    );

    h.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(writeModerationVerdict('ff1', claimedAt, patch)).resolves.toBe(false);
  });

  it('releases only a claim that is still ours, back to pending with attempt bookkeeping', async () => {
    await releaseModerationClaim('ff1', claimedAt);

    const [filter, update] = h.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'ff1', moderationStatus: 'scanning', moderationClaimedAt: claimedAt });
    expect(update.$set).toMatchObject({ moderationStatus: 'pending', moderationLastAttemptAt: expect.any(Date) });
    expect(update.$inc).toEqual({ moderationAttempts: 1 });
    expect(update.$unset).toEqual({ moderationClaimedAt: 1 });
  });

  it('builds the verdict patch with a block reason only when there is one', () => {
    expect(toVerdictPatch({ moderationStatus: 'clean' })).toEqual({ moderationStatus: 'clean' });
    expect(toVerdictPatch({ moderationStatus: 'blocked', blockReason: 'unsupported_format' })).toEqual({
      moderationStatus: 'blocked',
      blockReason: 'unsupported_format',
    });
  });

  describe('scanUploadedObject', () => {
    const fabFile = { id: 'ff1', userId: 'u1', mimeType: null };

    it('reads the scanned bytes from the object key it was given', async () => {
      await scanUploadedObject({ fabFile, objectKey: 'masks/m.png', logger });

      const args = h.moderateUploadedFile.mock.calls[0][0];
      await args.downloadBytes();
      await args.downloadPartialBytes(512);

      expect(h.download).toHaveBeenCalledWith('masks/m.png');
      expect(h.downloadRange).toHaveBeenCalledWith('masks/m.png', 512);
    });

    it('passes the file identity through and turns a null mime type into undefined', async () => {
      await scanUploadedObject({ fabFile, objectKey: 'masks/m.png', logger });

      expect(h.moderateUploadedFile).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', fabFileId: 'ff1', mimeType: undefined })
      );
    });

    it('defaults moderation to enabled when the setting is unset, and honors an explicit off', async () => {
      await scanUploadedObject({ fabFile, objectKey: 'masks/m.png', logger });
      expect(h.moderateUploadedFile.mock.calls[0][0].enabled).toBe(true);

      h.getSettingsValue.mockReturnValue(false);
      await scanUploadedObject({ fabFile, objectKey: 'masks/m.png', logger });
      expect(h.moderateUploadedFile.mock.calls[1][0].enabled).toBe(false);
    });

    it('returns the scan result unchanged', async () => {
      h.moderateUploadedFile.mockResolvedValue({ moderationStatus: 'blocked', blockReason: 'explicit' });

      await expect(scanUploadedObject({ fabFile, objectKey: 'masks/m.png', logger })).resolves.toEqual({
        moderationStatus: 'blocked',
        blockReason: 'explicit',
      });
    });
  });
});

describe('scanUploadedObject - ai:generate-only upload constraint', () => {
  const scan = (sourceMetadata?: unknown) =>
    scanUploadedObject({
      fabFile: { id: 'ff1', userId: 'u1', mimeType: 'image/png', sourceMetadata },
      objectKey: 'k.png',
      logger,
    });
  const passed = () => h.moderateUploadedFile.mock.calls[0][0].generateUpload;

  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettingsValue.mockReturnValue(undefined);
    h.moderateUploadedFile.mockResolvedValue({ moderationStatus: 'clean' });
  });

  it('hands a marked file a constraint that measures the stored object', async () => {
    h.getMetadata.mockResolvedValue({ size: 1234 });
    await scan({ uploadedVia: 'ai-generate-key-upload' });
    await expect(passed().measureSize()).resolves.toBe(1234);
    expect(h.getMetadata).toHaveBeenCalledWith('k.png');
  });

  it('treats an unknown stored size as oversized', async () => {
    h.getMetadata.mockResolvedValue({});
    await scan({ uploadedVia: 'ai-generate-key-upload' });
    await expect(passed().measureSize()).resolves.toBe(Number.POSITIVE_INFINITY);
  });

  it.each([[undefined], [{}], [{ uploadedVia: 'other' }]])('passes no constraint for %j', async meta => {
    await scan(meta);
    expect(passed()).toBeUndefined();
  });
});
