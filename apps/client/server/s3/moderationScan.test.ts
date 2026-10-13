import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findOneAndUpdate: vi.fn(), updateOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  FabFile: { findOneAndUpdate: h.findOneAndUpdate, updateOne: h.updateOne },
  adminSettingsRepository: {},
  imageModerationIncidentRepository: {},
}));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@bike4mind/utils', () => ({ getSettingsMap: vi.fn(async () => ({})), getSettingsValue: () => true }));
vi.mock('@bike4mind/utils/imageModeration', () => ({ RekognitionImageModerationService: class {} }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ download: vi.fn(), downloadRange: vi.fn() }) }));
vi.mock('@server/s3/moderateUploadedFile', () => ({ moderateUploadedFile: vi.fn() }));

import { claimModerationScan, releaseModerationClaim, toVerdictPatch, writeModerationVerdict } from './moderationScan';

const claimedAt = new Date('2026-10-13T00:00:00Z');

describe('moderationScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.updateOne.mockResolvedValue({ matchedCount: 1 });
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
});
