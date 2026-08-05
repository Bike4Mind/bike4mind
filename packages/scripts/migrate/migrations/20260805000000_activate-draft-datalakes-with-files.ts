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
 * Runs the real `recomputeLakeStats` per candidate rather than a hand-rolled updateMany. The
 * stuck lakes are exactly the ones whose stats no door refreshed, so their persisted `fileCount`
 * cannot be trusted as the predicate - the aggregate has to decide. Recomputing also repairs the
 * counts, and the activation then falls out of the same shipped code path the doors use, so this
 * cannot disagree with them.
 *
 * Idempotent: a second run finds no lake left in a draft/absent status and matches nothing.
 */

const LOG = '[activate-draft-datalakes-with-files]';

// `null` matches an absent field as well as an explicit null. `status` carries a schema default,
// so only rows written before the field existed lack one - the oldest lakes in the database, and
// just as invisible to the catalog as a draft. The same filter the live transition uses.
const DRAFT_STATUSES = { $in: ['draft', null] };

const migration: MigrationFile = {
  id: 20260805000000,
  name: 'activate-draft-datalakes-with-files',

  up: async () => {
    const lakes = await DataLakeModel.find({ status: DRAFT_STATUSES });
    if (lakes.length === 0) {
      console.log(`${LOG} no draft lakes, nothing to do`);
      return;
    }

    let activated = 0;
    let stillEmpty = 0;
    const failed: string[] = [];

    for (const lake of lakes) {
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

    console.log(
      `${LOG} activated ${activated} lake(s); ${stillEmpty} still empty, ${failed.length} failed, ${lakes.length} scanned`
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
