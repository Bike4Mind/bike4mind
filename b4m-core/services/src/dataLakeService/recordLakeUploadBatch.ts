import type { IDataLakeAccessGrantRepository, IDataLakeBatch, IDataLakeBatchRepository } from '@bike4mind/common';
import { loadActiveLakeGrants } from './authorizeLakeManage';
import { uploadBatchChange, type UploadBatchOutcome } from './diffLakeConfig';
import type { LakeGrant } from './manageRule';
import {
  recordLakeConfigChange,
  type LakeConfigAuditAdapters,
  type LakeConfigAuditLakeRef,
} from './recordLakeConfigChange';

export interface RecordLakeUploadBatchAdapters extends LakeConfigAuditAdapters {
  db: LakeConfigAuditAdapters['db'] & {
    /** Required: the one-shot claim is what keeps a reopened, re-finalized batch to a single row. */
    batches: Pick<IDataLakeBatchRepository, 'claimUploadHistory'>;
    /** Lets the uploader's rung resolve to a grant (curator, owner) instead of falling to `system`.
     * Only consulted for a batch that carries no `uploaderManageRung`. */
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  };
}

/**
 * Records one settled upload batch as an `upload-files` History row, attributed to the batch's
 * uploader. Called from every door that settles a batch - the guarded finalize, the cancel route
 * and the stuck-batch reconciler - and writes at most once per batch however many of them run,
 * because History rows are permanent and a reopened batch finalizes a second time.
 *
 * Best-effort end to end: the claim and the grants read sit outside `recordLakeConfigChange`'s try,
 * so each has its own catch - a rejection here would otherwise surface from batch finalization.
 */
export async function recordLakeUploadBatch(
  lake: LakeConfigAuditLakeRef,
  batch: Pick<
    IDataLakeBatch,
    'userId' | 'vectorizedFiles' | 'failedFiles' | 'skippedFiles' | 'deferredFiles' | 'uploaderManageRung'
  > & { id: string },
  { db, logger }: RecordLakeUploadBatchAdapters,
  outcome: UploadBatchOutcome = 'finished'
): Promise<void> {
  if (batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles + (batch.deferredFiles ?? 0) === 0) return;

  try {
    if (!(await db.batches.claimUploadHistory(batch.id))) return;
  } catch (err) {
    logger?.warn?.('[dataLakes] could not claim the upload history row; skipping it', { batchId: batch.id, err });
    return;
  }

  let grants: LakeGrant[] = [];
  if (!batch.uploaderManageRung) {
    try {
      grants = await loadActiveLakeGrants(lake, { db });
    } catch (err) {
      logger?.warn?.('[dataLakes] could not read grants for the upload history row; rung may read as system', {
        dataLakeId: lake.id,
        err,
      });
    }
  }

  await recordLakeConfigChange(
    {
      actor: { userId: batch.userId, isAdmin: false, administeredOrgIds: [] },
      lake,
      grants,
      action: 'upload-files',
      changes: [uploadBatchChange(batch, outcome)],
      manageRung: batch.uploaderManageRung,
    },
    { db, logger }
  );
}
