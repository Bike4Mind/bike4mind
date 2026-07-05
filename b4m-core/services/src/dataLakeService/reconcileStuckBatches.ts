import type {
  IDataLakeBatchDocument,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
} from '@bike4mind/common';
import { BATCH_NON_TERMINAL_STATUSES } from '@bike4mind/common';
import { recomputeLakeStats } from './recomputeLakeStats';

/** Default stuck-batch timeout: a non-terminal batch idle longer than this is forced terminal. */
export const DEFAULT_STUCK_BATCH_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface ReconcileStuckBatchesAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'setStats'>;
    batches: Pick<IDataLakeBatchRepository, 'markTerminalIfActive'>;
    fabFiles: Pick<IFabFileRepository, 'computeDataLakeStats'>;
  };
  logger?: { info: (msg: string, ...args: unknown[]) => void; warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Read-time reconciler. Given a set of (already-fetched) batches, forces any
 * non-terminal batch idle past `timeoutMs` to 'completed_with_errors' via a GUARDED
 * transition (markTerminalIfActive only succeeds while still non-terminal), so it
 * cannot race a genuinely-late real increment into a double-finalize. Lake stats are
 * recomputed from source for each forced batch, making a late signal harmless.
 *
 * Returns the ids of batches it forced terminal (for observability - this count is
 * "work being lost").
 */
export const reconcileStuckBatches = async (
  batches: IDataLakeBatchDocument[],
  timeoutMs: number,
  { db, logger }: ReconcileStuckBatchesAdapters,
  now: number = Date.now()
): Promise<string[]> => {
  const forced: string[] = [];

  const stuck = batches.filter(b => {
    if (!BATCH_NON_TERMINAL_STATUSES.includes(b.status)) return false;
    const updatedAt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return now - updatedAt > timeoutMs;
  });

  for (const batch of stuck) {
    const won = await db.batches.markTerminalIfActive(batch.id, 'completed_with_errors');
    if (!won) continue; // a real increment finalized it first - nothing to reconcile.
    forced.push(batch.id);
    logger?.warn(`Reconciler forced stuck batch ${batch.id} terminal (idle > ${timeoutMs}ms)`);
    try {
      const lake = await db.dataLakes.findById(batch.dataLakeId);
      if (lake) {
        await recomputeLakeStats(lake.id, lake.datalakeTag, { db });
      }
    } catch (error) {
      logger?.warn(`Reconciler stat recompute failed for batch ${batch.id}:`, error);
    }
  }

  if (forced.length > 0) {
    logger?.info(`Reconciler forced ${forced.length} stuck batch(es) terminal`);
  }
  return forced;
};
