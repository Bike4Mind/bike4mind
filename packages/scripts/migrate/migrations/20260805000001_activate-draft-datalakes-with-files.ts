import { DataLakeModel, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { type MigrationFile } from './index';

/**
 * Migration: repair the stats of the draft lakes that were filled through a door that never
 * wrote them.
 *
 * ORIGINALLY this also published those lakes: it leaned on `recomputeLakeStats`, which used to
 * flip a draft lake to active whenever the recomputed fileCount was nonzero. That side effect is
 * gone - publishing is now the explicit, owner/admin-only `promoteDataLake` door - so this pass
 * only trues up fileCount/totalSizeBytes. Draft lakes stay draft, by design, and their owners
 * publish them from the manager when they choose to.
 *
 * Runs the real `recomputeLakeStats` per candidate rather than a hand-rolled updateMany. Some
 * of these lakes were filled through a door that wrote no stats either, so a persisted
 * `fileCount` of 0 does not mean empty and is no predicate to select on - the aggregate has to
 * decide.
 *
 * Re-runnable: the writes are idempotent, and a repeat recompute writes the same counts.
 */

const LOG = '[activate-draft-datalakes-with-files]';

// `null` matches an absent field as well as an explicit null. `status` carries a schema default,
// so only rows written before the field existed lack one - the oldest lakes in the database, and
// just as invisible to the catalog as a draft. The same filter the live transition uses.
const DRAFT_STATUSES = { $in: ['draft', null] };

const migration: MigrationFile = {
  id: 20260805000001,
  name: 'activate-draft-datalakes-with-files',

  up: async () => {
    let scanned = 0;
    let withFiles = 0;
    let stillEmpty = 0;
    const failed: string[] = [];

    // A cursor rather than `.find()` materializing the whole result: the candidate set is
    // every draft lake ever created, including ones that recompute to 0 files and get
    // selected again on every future deploy, so it has no natural bound to size an array for.
    const cursor = DataLakeModel.find({ status: DRAFT_STATUSES }).cursor();
    for await (const lake of cursor) {
      scanned++;
      try {
        // The lake DOCUMENT: recomputeLakeStats derives the two-signal membership scope from it,
        // and a partial one silently counts the meta-tag arm alone.
        const stats = await dataLakeService.recomputeLakeStats(lake, {
          db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository },
        });
        if (stats.fileCount > 0) {
          withFiles++;
          console.log(`${LOG} recomputed "${lake.name}" (${stats.fileCount} file(s); stays draft)`);
        } else {
          stillEmpty++;
        }
      } catch (error) {
        // Per lake: one unreadable lake must not strand the rest, and a migration that threw
        // here would block the whole deploy over a cache rebuild.
        failed.push(`"${lake.name}": ${error}`);
      }
    }

    if (scanned === 0) {
      console.log(`${LOG} no draft lakes, nothing to do`);
      return;
    }

    console.log(
      `${LOG} recomputed ${withFiles} draft lake(s) holding files; ${stillEmpty} still empty, ` +
        `${failed.length} failed, ${scanned} scanned`
    );
    if (failed.length > 0) {
      console.log(`${LOG} ${failed.length} lake(s) failed and keep their stale counts until a door touches them:`);
      for (const line of failed) console.log(`  ${line}`);
    }
  },

  // Irreversible on purpose: the prior counts were the stale ones this pass exists to correct.
  down: async () => {},
};

export default migration;
