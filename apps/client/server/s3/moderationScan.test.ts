import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  download: vi.fn(),
  downloadRange: vi.fn(),
  moderateUploadedFile: vi.fn(),
  getMetadata: vi.fn(),
  getSettingsValue: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  FabFile: { findOneAndUpdate: h.findOneAndUpdate, updateOne: h.updateOne },
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
vi.mock('@server/s3/moderateUploadedFile', () => ({ moderateUploadedFile: h.moderateUploadedFile }));

import {
  claimModerationScan,
  releaseModerationClaim,
  scanUploadedObject,
  toVerdictPatch,
  writeModerationVerdict,
} from './moderationScan';

const claimedAt = new Date('2026-10-13T00:00:00Z');
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe('moderationScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.updateOne.mockResolvedValue({ matchedCount: 1 });
    h.getSettingsValue.mockReturnValue(undefined);
    h.moderateUploadedFile.mockResolvedValue({ moderationStatus: 'clean' });
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
