import { describe, it, expect, vi } from 'vitest';
import { recordLakeUploadBatch } from './recordLakeUploadBatch';

const lake = { id: 'lake-1', createdByUserId: 'creator', organizationId: undefined };
const batch = { userId: 'curator', vectorizedFiles: 4, failedFiles: 1, skippedFiles: 0 };

describe('recordLakeUploadBatch', () => {
  it('records one upload-files row attributed to the uploader, with the rung their grant gives', async () => {
    const record = vi.fn(async () => ({}) as never);
    const listByLake = vi.fn(async () => [{ principalType: 'user', principalId: 'curator', role: 'curator' }] as never);
    await recordLakeUploadBatch(lake, batch, {
      db: { lakeConfigChangeEvents: { record }, dataLakeAccessGrants: { listByLake } },
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
  });

  it('still records when the grants read fails, rather than failing the batch finalize', async () => {
    const record = vi.fn(async () => ({}) as never);
    const listByLake = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = { warn: vi.fn() };
    await expect(
      recordLakeUploadBatch(lake, batch, {
        db: { lakeConfigChangeEvents: { record }, dataLakeAccessGrants: { listByLake } },
        logger,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'upload-files', manageRung: 'system' }));
  });

  it('records nothing for a batch that processed no files', async () => {
    const record = vi.fn(async () => ({}) as never);
    await recordLakeUploadBatch(
      lake,
      { ...batch, vectorizedFiles: 0, failedFiles: 0 },
      {
        db: { lakeConfigChangeEvents: { record } },
      }
    );
    expect(record).not.toHaveBeenCalled();
  });
});
