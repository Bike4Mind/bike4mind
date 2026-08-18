import { dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

/**
 * Rebuild the persisted stats of every lake named by a `datalake:` meta-tag in `tagNames` - for
 * the file doors that move lake membership as a side effect and have no other pass that notices.
 *
 * Both directions:
 * - Leaving, on `DELETE /api/files/[id]` and `POST /api/files/bulk-delete`, because
 *   `computeDataLakeStats` excludes `deletedAt` and the lake would go on counting the file. Call
 *   it with the tags of files whose outcome was 'deleted' only: an 'unshared' edits the file's
 *   `users` array and touches neither `tags` nor `userId`, so neither membership arm moves.
 * - Joining, through `recomputeStatsForUploadedFile`, once an upload's bytes actually land. The
 *   upload doors stamp a lake's meta-tag on a row they create before the browser sends anything,
 *   and neither runs a membership service, so without that call the lake's counts stay stale and
 *   a lake still in 'draft' never activates. See `recomputeLakeStats`, which owns the transition,
 *   and that helper for why the count cannot be taken at create time.
 *
 * Takes the tags of ALL affected files at once and recomputes each distinct lake a single time,
 * which is what keeps a bulk delete of N files in one lake from running N identical aggregations.
 *
 * Best-effort by design, and per lake: the write has already committed, one unresolvable or
 * unwritable lake must not skip the rest, and stats are a cache the batch finalizer and the
 * read-time reconciler also rebuild. Callers must invoke it AFTER their transaction commits, or
 * the aggregation will not see the write it is meant to count.
 *
 * Prefix-only members are not healed here: resolving a prefix back to its lake needs a scan
 * across lakes, and gating that arm is #1263 (blocked on #1152 for prefix uniqueness).
 */
export const recomputeStatsForLakeTags = async (
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
      logger.error('Error recomputing data lake stats after a file write:', { error, metaTag });
    }
  }
};
