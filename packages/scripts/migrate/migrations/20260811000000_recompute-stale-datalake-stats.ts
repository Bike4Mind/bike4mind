import { DataLakeModel, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { type MigrationFile } from './index';

/**
 * Migration: true up every lake's fileCount/totalSizeBytes against its real membership.
 *
 * Before the prefix-arm membership gap closed, a file's ONLY prefix-arm signal for a lake could
 * be dropped without recomputing that lake's stats - the write door skipped both the
 * manage-rights gate and the recompute a meta-tag leave already got. A lake affected this way
 * carries a stale (too-high) fileCount/totalSizeBytes until its next write happens to touch it
 * again, which may never happen for a quiet lake.
 *
 * Recomputes every lake unconditionally rather than trying to detect which ones are stale -
 * there is no persisted signal for "this lake lost a prefix-arm member before the gate closed,"
 * so the honest fix is to true up the whole collection once. `recomputeLakeStats` is cheap per
 * lake (one aggregate + one write), but NOT a plain no-op on an already-correct lake: it also
 * flips a draft lake to active (`activateIfDraft`) whenever the recomputed fileCount is nonzero,
 * a one-way publication change - logged separately below, since the stats-delta check alone
 * would miss a lake whose counts were already right but whose activation had been skipped.
 *
 * Excludes 'deleting'/'deleted' lakes: `deleteDataLake`'s phase 1 deliberately leaves their stats
 * untouched (unlike archive, which recomputes to 0 itself) so a recoverable deleted lake still
 * shows its pre-delete counts - recomputing here would zero them out as a false "correction".
 */

const LOG = '[recompute-stale-datalake-stats]';

const migration: MigrationFile = {
  id: 20260811000000,
  name: 'recompute-stale-datalake-stats',

  up: async () => {
    let scanned = 0;
    let corrected = 0;
    let activated = 0;
    const failed: string[] = [];

    // A cursor rather than `.find()` materializing the whole result: this scans every lake ever
    // created (short of the deliberately-frozen deleted/deleting ones), with no natural bound to
    // size an array for.
    const cursor = DataLakeModel.find({ status: { $nin: ['deleting', 'deleted'] } }).cursor();
    for await (const lake of cursor) {
      scanned++;
      try {
        const wasDraft = lake.status === 'draft' || !lake.status;
        const before = { fileCount: lake.fileCount ?? 0, totalSizeBytes: lake.totalSizeBytes ?? 0 };
        // The lake DOCUMENT: recomputeLakeStats derives the two-signal membership scope from it,
        // and a partial one silently counts the meta-tag arm alone.
        const after = await dataLakeService.recomputeLakeStats(lake, {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
        });
        if (after.fileCount !== before.fileCount || after.totalSizeBytes !== before.totalSizeBytes) {
          corrected++;
          console.log(
            `${LOG} corrected "${lake.name}": fileCount ${before.fileCount} -> ${after.fileCount}, ` +
              `totalSizeBytes ${before.totalSizeBytes} -> ${after.totalSizeBytes}`
          );
        }
        // Reported independently of the stats delta above: a lake whose counts were already
        // correct but whose activation had been skipped shows no delta there at all.
        if (wasDraft && after.fileCount > 0) {
          activated++;
          console.log(`${LOG} activated "${lake.name}" (${after.fileCount} file(s))`);
        }
      } catch (error) {
        // Per lake: one unreadable lake must not strand the rest, and a migration that threw here
        // would block the whole deploy over a stats-cache rebuild.
        failed.push(`"${lake.name}": ${error}`);
      }
    }

    if (scanned === 0) {
      console.log(`${LOG} no lakes, nothing to do`);
      return;
    }

    console.log(
      `${LOG} corrected ${corrected} lake(s), activated ${activated} lake(s); ` +
        `${failed.length} failed, ${scanned} scanned`
    );
    if (failed.length > 0) {
      console.log(`${LOG} ${failed.length} lake(s) failed and stay as-is until a door touches them:`);
      for (const line of failed) console.log(`  ${line}`);
    }
  },

  // Irreversible on purpose: the prior counts were the STALE ones this migration exists to
  // correct, so reverting would restore the incorrect data by definition.
  down: async () => {},
};

export default migration;
