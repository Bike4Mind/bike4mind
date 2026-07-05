import { dataLakeBatchRepository, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { IDataLakeBatchDocument } from '@bike4mind/common';

/**
 * Guarded batch finalization shared by the chunk and vectorize handlers. When the
 * completion threshold is crossed, transition the batch terminal via a GUARDED update
 * so exactly one caller wins; the winner recomputes the lake's authoritative stats
 * from SOURCE records (never from the running counters). Safe to call after any
 * counter increment.
 */
export async function finalizeBatchIfComplete(
  batch: IDataLakeBatchDocument | null,
  logger: { error: (msg: string) => void }
): Promise<void> {
  if (!batch) return;
  if (batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles < batch.totalFiles) return;

  const finalized = await dataLakeBatchRepository.markTerminalIfActive(
    batch.id,
    batch.failedFiles > 0 ? 'completed_with_errors' : 'completed'
  );
  if (!finalized) return; // another handler finalized first — don't double-recompute.

  try {
    const lake = await dataLakeRepository.findById(batch.dataLakeId);
    if (lake) {
      await dataLakeService.recomputeLakeStats(lake.id, lake.datalakeTag, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });
    }
  } catch (error) {
    logger.error(`Error recomputing lake stats for batch ${batch.id}: ${error}`);
  }
}

/** True once a batch has reached its completion threshold. */
export function isBatchComplete(batch: IDataLakeBatchDocument | null): boolean {
  return !!batch && batch.vectorizedFiles + batch.failedFiles + batch.skippedFiles >= batch.totalFiles;
}
