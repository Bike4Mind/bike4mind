import type { IDataLakeAccessGrantRepository, IDataLakeBatch } from '@bike4mind/common';
import { uploadBatchChange } from './diffLakeConfig';
import type { LakeGrant } from './manageRule';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from './recordLakeConfigChange';

export interface RecordLakeUploadBatchAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    /** Lets the uploader's rung resolve to a grant (curator, owner) instead of falling to `system`. */
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Records one finished upload batch as an `upload-files` History row, attributed to the batch's
 * uploader. Call it once per batch, from the single guarded finalize winner.
 *
 * Best-effort end to end: the grants read sits inside its own catch because it runs outside
 * `recordLakeConfigChange`'s try, and a rejection here would surface from batch finalization.
 */
export async function recordLakeUploadBatch(
  lake: LakeConfigAuditLakeRef,
  batch: Pick<IDataLakeBatch, 'userId' | 'vectorizedFiles' | 'failedFiles' | 'skippedFiles' | 'deferredFiles'>,
  { db, logger }: RecordLakeUploadBatchAdapters
): Promise<void> {
  if (batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles === 0) return;

  let grants: LakeGrant[] = [];
  try {
    grants = (await db.dataLakeAccessGrants?.listByLake(lake.id)) ?? [];
  } catch (err) {
    logger?.warn?.('[dataLakes] could not read grants for the upload history row; rung may read as system', {
      dataLakeId: lake.id,
      err,
    });
  }

  await recordLakeConfigChange(
    {
      actor: { userId: batch.userId, isAdmin: false, administeredOrgIds: [] },
      lake,
      grants,
      action: 'upload-files',
      changes: [uploadBatchChange(batch)],
    },
    { db, logger }
  );
}
