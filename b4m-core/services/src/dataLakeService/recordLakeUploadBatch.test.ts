import { describe, it, expect, vi } from 'vitest';
import { recordLakeUploadBatch } from './recordLakeUploadBatch';

const lake = { id: 'lake-1', createdByUserId: 'creator', organizationId: undefined };
const batch = { id: 'b1', userId: 'curator', vectorizedFiles: 4, failedFiles: 1, skippedFiles: 0 };

/** A claim that behaves like the repository's: the first call wins, every later one loses. */
const oneShotClaim = () => {
  let claimed = false;
  return vi.fn(async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
};

describe('recordLakeUploadBatch', () => {
  it('records one upload-files row attributed to the uploader, with the rung their grant gives', async () => {
    const record = vi.fn(async () => ({}) as never);
    const listByLake = vi.fn(async () => [{ principalType: 'user', principalId: 'curator', role: 'curator' }] as never);
    await recordLakeUploadBatch(lake, batch, {
      db: {
        lakeConfigChangeEvents: { record },
        batches: { claimUploadHistory: oneShotClaim() },
        dataLakeAccessGrants: { listByLake },
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upload-files',
        principalKind: 'user',
        principalId: 'curator',
        manageRung: 'grant-curator',
        changes: [{ field: 'upload', kind: 'literal', after: '4 files added (1 failed)' }],
      })
    );
    // Expired grants must not name the rung.
    expect(listByLake).toHaveBeenCalledWith('lake-1', { activeAsOf: expect.any(Date) });
  });

  it('uses the rung stored at batch creation, so an org admin upload is not recorded as system', async () => {
    const record = vi.fn(async () => ({}) as never);
    const listByLake = vi.fn(async () => [] as never);
    await recordLakeUploadBatch(
      { ...lake, organizationId: 'org-1' },
      { ...batch, userId: 'org-admin-user', uploaderManageRung: 'org-admin' },
      {
        db: {
          lakeConfigChangeEvents: { record },
          batches: { claimUploadHistory: oneShotClaim() },
          dataLakeAccessGrants: { listByLake },
        },
      }
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'org-admin-user', manageRung: 'org-admin' })
    );
    expect(listByLake).not.toHaveBeenCalled();
  });

  it('writes one row for a batch that is reopened and finalized again', async () => {
    const record = vi.fn(async () => ({}) as never);
    const adapters = {
      db: { lakeConfigChangeEvents: { record }, batches: { claimUploadHistory: oneShotClaim() } },
    };
    await recordLakeUploadBatch(lake, { ...batch, vectorizedFiles: 9, failedFiles: 1 }, adapters);
    await recordLakeUploadBatch(lake, { ...batch, vectorizedFiles: 10, failedFiles: 0 }, adapters);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [expect.objectContaining({ after: '9 files added (1 failed)' })] })
    );
  });

  it('skips the row, without throwing, when the claim read fails', async () => {
    const record = vi.fn(async () => ({}) as never);
    const logger = { warn: vi.fn() };
    await expect(
      recordLakeUploadBatch(lake, batch, {
        db: {
          lakeConfigChangeEvents: { record },
          batches: {
            claimUploadHistory: vi.fn(async () => {
              throw new Error('db down');
            }),
          },
        },
        logger,
      })
    ).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('still records when the grants read fails, rather than failing the batch finalize', async () => {
    const record = vi.fn(async () => ({}) as never);
    const listByLake = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = { warn: vi.fn() };
    await expect(
      recordLakeUploadBatch(lake, batch, {
        db: {
          lakeConfigChangeEvents: { record },
          batches: { claimUploadHistory: oneShotClaim() },
          dataLakeAccessGrants: { listByLake },
        },
        logger,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'upload-files', manageRung: 'system' }));
  });

  it('records nothing, and claims nothing, for a batch that processed no files', async () => {
    const record = vi.fn(async () => ({}) as never);
    const claimUploadHistory = oneShotClaim();
    await recordLakeUploadBatch(
      lake,
      { ...batch, vectorizedFiles: 0, failedFiles: 0 },
      { db: { lakeConfigChangeEvents: { record }, batches: { claimUploadHistory } } }
    );
    expect(record).not.toHaveBeenCalled();
    expect(claimUploadHistory).not.toHaveBeenCalled();
  });

  it('records a batch whose only files were written off unfinished', async () => {
    const record = vi.fn(async () => ({}) as never);
    await recordLakeUploadBatch(
      lake,
      { ...batch, vectorizedFiles: 0, failedFiles: 0, deferredFiles: 3 },
      { db: { lakeConfigChangeEvents: { record }, batches: { claimUploadHistory: oneShotClaim() } } }
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ changes: [expect.objectContaining({ after: '0 files added (3 not finished)' })] })
    );
  });

  it('says when a batch was cancelled or stopped rather than finished', async () => {
    const record = vi.fn(async () => ({}) as never);
    const db = { lakeConfigChangeEvents: { record } };
    await recordLakeUploadBatch(
      lake,
      batch,
      { db: { ...db, batches: { claimUploadHistory: oneShotClaim() } } },
      'cancelled'
    );
    await recordLakeUploadBatch(
      lake,
      batch,
      { db: { ...db, batches: { claimUploadHistory: oneShotClaim() } } },
      'stopped'
    );
    expect(record.mock.calls.map(([event]) => (event as { changes: { after: string }[] }).changes[0].after)).toEqual([
      'Upload cancelled: 4 files added (1 failed)',
      'Upload stopped: 4 files added (1 failed)',
    ]);
  });
});
