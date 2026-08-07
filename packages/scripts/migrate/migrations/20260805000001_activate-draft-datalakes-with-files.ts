import { DataLakeModel, dataLakeRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { type MigrationFile } from './index';

/**
 * Migration: activate the lakes that were filled through a door that never activated them.
 *
 * Every lake is created in 'draft', and only batch creation used to flip it to 'active' - the
 * status the Discover catalog and the findActive* retrieval arms both require. A lake filled
 * through the tag toggle, Send to Data Lake, or a direct file create therefore stayed draft
 * forever, invisible to everyone but its owner. The live doors now activate through
 * `recomputeLakeStats`, but only when they next run, so a lake nobody touches again stays stuck.
 *
 * Runs the real `recomputeLakeStats` per candidate rather than a hand-rolled updateMany. Some
 * of these lakes were filled through a door that wrote no stats either, so a persisted
 * `fileCount` of 0 does not mean empty and is no predicate to select on - the aggregate has to
 * decide. Recomputing repairs the counts on the way past, and the activation then falls out of
 * the same code path the live doors use rather than a second copy of the rule.
 *
 * Re-runnable, not a no-op: a lake that recomputes to 0 files stays draft and is scanned again.
 * The writes are idempotent - an already-active lake is not selected, and a repeat recompute
 * writes the same counts.
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
    let activated = 0;
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
          activated++;
          console.log(`${LOG} activated "${lake.name}" (${stats.fileCount} file(s))`);
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
      `${LOG} activated ${activated} lake(s); ${stillEmpty} still empty, ${failed.length} failed, ${scanned} scanned`
    );
    if (failed.length > 0) {
      console.log(`${LOG} ${failed.length} lake(s) failed and stay draft until a door touches them:`);
      for (const line of failed) console.log(`  ${line}`);
    }
  },

  // Irreversible on purpose. The transition is one-way by design and nothing records which pass
  // performed it, so re-drafting every active lake with files would also hide lakes the live
  // doors activated legitimately - re-creating the very bug this fixes.
  down: async () => {},
};

export default migration;
