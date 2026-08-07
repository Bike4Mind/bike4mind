import type { IDataLakeBatchSummary, IDataLakeBatchRepository } from '@bike4mind/common';
import { TAXONOMY_NON_TERMINAL_STATUSES } from '@bike4mind/common';

/** Default stuck-taxonomy timeout: a non-terminal AI-tagging phase idle longer than this is
 * forced to 'failed'. Shorter than DEFAULT_STUCK_BATCH_TIMEOUT_MS (30 min) - this is one
 * bounded LLM call, not a multi-file pipeline, so a real run should never take this long. */
export const DEFAULT_STUCK_TAXONOMY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface ReconcileStuckTaxonomyAdapters {
  db: {
    batches: Pick<IDataLakeBatchRepository, 'forceFailStuckTaxonomy'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/**
 * Read-time/cron reconciler for the background AI-tagging phase, mirroring
 * reconcileStuckBatches's shape: given already-fetched batches, force any non-terminal
 * `taxonomyStatus` idle past `timeoutMs` to 'failed' via a GUARDED transition, so it can't
 * race a genuinely-late real completion into overwriting a 'ready' result. No lake-stats
 * recompute needed - taxonomy suggestions never change fileCount/totalSizeBytes.
 *
 * The write itself is ALSO guarded on staleness (`forceFailStuckTaxonomy`, not the plain
 * status-only `setTaxonomyStatusIfActive`): the `stuck` filter below only proves a batch
 * *looked* stale in the snapshot read above, not that it's still stale at write time - a batch
 * that legitimately re-claimed (a manual re-analyze) in between would otherwise still pass a
 * status-only guard, discarding real in-flight work.
 */
export const reconcileStuckTaxonomy = async (
  batches: IDataLakeBatchSummary[],
  timeoutMs: number,
  { db, logger }: ReconcileStuckTaxonomyAdapters,
  now: number = Date.now()
): Promise<string[]> => {
  const forced: string[] = [];
  const cutoff = new Date(now - timeoutMs);

  const stuck = batches.filter(b => {
    if (!b.taxonomyStatus || !TAXONOMY_NON_TERMINAL_STATUSES.includes(b.taxonomyStatus)) return false;
    const startedAt = b.taxonomyStartedAt ? new Date(b.taxonomyStartedAt).getTime() : 0;
    return startedAt < cutoff.getTime();
  });

  for (const batch of stuck) {
    const won = await db.batches.forceFailStuckTaxonomy(
      batch.id,
      TAXONOMY_NON_TERMINAL_STATUSES,
      cutoff,
      'Timed out waiting for AI tag suggestion'
    );
    if (!won) continue; // a real completion, or a fresh re-claim, won the race first.
    forced.push(batch.id);
    logger?.warn(`Reconciler forced stuck taxonomy job on batch ${batch.id} to failed (idle > ${timeoutMs}ms)`);
  }

  return forced;
};
