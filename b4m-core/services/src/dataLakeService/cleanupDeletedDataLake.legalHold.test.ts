/**
 * Focused test: legal-hold skip in cleanupDeletedDataLake when deleteFileAndChunks throws.
 *
 * The production lake-sweep worker always injects `deleteFileAndChunks` (pointing at
 * fabFileRepository.hardDeleteWithChunks). Before F3 the catch only covered the `else`
 * branch, so a blocked file sent the whole purge to the DLQ. The fix wraps both branches
 * in one outer try/catch. This test exercises the injected-function path specifically.
 */
import { describe, it, expect, vi } from 'vitest';
import { LegalHoldError } from '@bike4mind/common';
import { cleanupDeletedDataLake } from './cleanupDeletedDataLake';

// Minimal ManageActor -- the permission check is bypassed via resumesStartedGeneration.
const ACTOR = { userId: 'user-1', isAdmin: false, administeredOrgIds: [] };
const CLAIM_ID = 'claim-test-1';
const LAKE_ID = 'lake-test-1';

// Minimal lake shape that satisfies cleanupDeletedDataLake's runtime checks.
const MOCK_LAKE = {
  _id: LAKE_ID,
  id: LAKE_ID,
  status: 'purging' as const,
  datalakeTag: 'dl-test-1',
  fileTagPrefix: undefined,
  createdByUserId: 'user-1',
  purgeStartedAt: new Date('2026-01-01T00:00:00Z'),
  purgeClaimId: CLAIM_ID,
};

function buildDb(overrides: Record<string, unknown> = {}) {
  return {
    dataLakes: {
      findById: vi.fn().mockResolvedValue(MOCK_LAKE),
      find: vi.fn().mockResolvedValue([]), // no colliding-prefix candidates
      delete: vi.fn().mockResolvedValue(undefined),
    },
    dataLakeAccessGrants: {
      listByLake: vi.fn().mockResolvedValue([]),
      removeAllForLake: vi.fn().mockResolvedValue(undefined),
    },
    batches: {
      find: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    fabFiles: {
      findIdsByDataLakeTag: vi.fn().mockResolvedValue(['file-blocked']),
      findStorageKeysByIds: vi.fn().mockResolvedValue([]),
      hardDeleteOneById: vi.fn(),
      findById: vi.fn().mockResolvedValue(null),
      pullTagsByFabFileId: vi.fn().mockResolvedValue(undefined),
    },
    fabFileChunks: {
      deleteManyByFabFileId: vi.fn(),
      clearRetrievalIndexConfirmedByFabFileIds: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

describe('cleanupDeletedDataLake - legal-hold skip (F3)', () => {
  it('completes the sweep and skips a blocked file when deleteFileAndChunks throws the legal-hold error', async () => {
    const db = buildDb();
    const legalHoldError = new LegalHoldError(
      "Cannot hard-delete FabFile file-blocked: moderationStatus is 'blocked' (legal hold)"
    );
    const deleteFileAndChunks = vi.fn().mockRejectedValue(legalHoldError);
    const logger = { warn: vi.fn() };

    // beginPurge + purgeClaimId matching the lake's purgeClaimId activates
    // resumesStartedGeneration, bypassing resolveCanManageLake.
    await expect(
      cleanupDeletedDataLake(ACTOR, LAKE_ID, {
        db,
        beginPurge: vi.fn().mockResolvedValue(true),
        purgeClaimId: CLAIM_ID,
        deleteFileAndChunks,
        logger,
      })
    ).resolves.toBeUndefined();

    // The blocked file was attempted.
    expect(deleteFileAndChunks).toHaveBeenCalledWith('file-blocked');

    // The sweep completed: the lake record was deleted despite the blocked file.
    expect(db.dataLakes.delete).toHaveBeenCalledWith(LAKE_ID);

    // The legal-hold skip was logged.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('legal hold'),
      expect.objectContaining({ fabFileId: 'file-blocked' })
    );
  });

  it('re-throws non-legal-hold errors from deleteFileAndChunks so the SQS message goes to the DLQ', async () => {
    const db = buildDb();
    const transientError = new Error('MongoDB transient network error');
    const deleteFileAndChunks = vi.fn().mockRejectedValue(transientError);

    await expect(
      cleanupDeletedDataLake(ACTOR, LAKE_ID, {
        db,
        beginPurge: vi.fn().mockResolvedValue(true),
        purgeClaimId: CLAIM_ID,
        deleteFileAndChunks,
      })
    ).rejects.toThrow('MongoDB transient network error');

    // Lake record must NOT be deleted on a transient error.
    expect(db.dataLakes.delete).not.toHaveBeenCalled();
  });
});
