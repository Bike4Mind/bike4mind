import { dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

/**
 * Rebuild the persisted stats of every lake named by a `datalake:` meta-tag on files that were
 * just soft-deleted. `computeDataLakeStats` excludes `deletedAt`, so a delete silently drops the
 * file out of the lake's membership and leaves `fileCount`/`totalSizeBytes` counting it.
 *
 * Shared by BOTH delete doors - `DELETE /api/files/[id]` and `POST /api/files/bulk-delete` - so
 * they cannot drift apart. Call it with the tags of files whose outcome was 'deleted' only: an
 * 'unshared' edits the file's `users` array and touches neither `tags` nor `userId`, so neither
 * membership arm moves and the stored counts are already right.
 *
 * Takes the tags of ALL affected files at once and recomputes each distinct lake a single time,
 * which is what keeps a bulk delete of N files in one lake from running N identical aggregations.
 *
 * Best-effort by design, and per lake: the deletes have already committed, one unresolvable or
 * unwritable lake must not skip the rest, and stats are a cache the batch finalizer and the
 * read-time reconciler also rebuild. Callers must invoke it AFTER their transaction commits, or
 * the aggregation will not see the `deletedAt` it is meant to count.
 *
 * Prefix-only members are not healed here: resolving a prefix back to its lake needs a scan
 * across lakes, and gating that arm is tracked separately.
 */
export const recomputeStatsForDeletedFiles = async (
  tagNames: readonly unknown[],
  { logger }: { logger: { error: (msg: string, meta?: Record<string, unknown>) => void } }
): Promise<void> => {
  for (const metaTag of dataLakeService.extractDataLakeMetaTags(tagNames)) {
    try {
      const lake = await dataLakeRepository.findByDatalakeTag(metaTag);
      // An orphaned meta-tag left behind by a deleted lake has no stats to rebuild.
      if (!lake) continue;
      // The lake DOCUMENT, not a narrower shape: recomputeLakeStats derives the two-signal
      // membership scope from it, and a partial one silently counts the meta-tag arm alone.
      await dataLakeService.recomputeLakeStats(lake, {
        db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
      });
    } catch (error) {
      logger.error('Error recomputing data lake stats after file delete:', { error, metaTag });
    }
  }
};
