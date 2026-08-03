import { DataLakeModel, FabFile, buildLacksContentPrefixTagFilter, dataLakeRepository } from '@bike4mind/database';
import { normalizeTagPrefix } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { type MigrationFile } from './index';

/**
 * Migration: stamp the content-prefix tag on files that joined a lake before the write doors
 * started doing it.
 *
 * The reconciler stamps `<fileTagPrefix>uncategorized` on a file that joins a lake carrying no tag
 * under that lake's prefix, but it runs at the write doors, so it only ever touches files written
 * after it shipped. A file already sitting in a lake with just its `datalake:<slug>` meta-tag
 * contributes nothing to the tag-count aggregates and appears under no category in the Explorer
 * tree, so a lake populated earlier still reads "No categories". Nothing heals those files on its
 * own: editing a lake carries no `fileTagPrefix` and so re-triggers no reconciliation, and no
 * lifecycle job rewrites tags.
 *
 * Every decision here is the reconciler's, reached through the same `decideStampPrefix` gate and
 * the same satisfaction predicate (via its datastore mirror), so the tags this writes are exactly
 * the tags the live doors would have written. There is ONE deliberate divergence, below.
 *
 * Idempotent: a second run finds every file already carries a tag under the prefix and matches
 * nothing.
 */

/** A lake the gate refused, kept so the run ends with one actionable report rather than a scroll. */
type SkippedLake = { name: string; prefix: string; why: string };

const LOG = '[backfill-datalake-content-prefix-tag]';

// Statuses whose files no longer belong to anyone: a lake mid-teardown is about to lose its files,
// so minting tags onto them is churn at best. Every other status keeps a browsable lake - an
// archived one is restorable, and its tree should be right when it comes back.
const TEARDOWN_STATUSES = ['deleting', 'deleted'];

const migration: MigrationFile = {
  id: 20260803000000,
  name: 'backfill-datalake-content-prefix-tag',

  up: async () => {
    const found = await DataLakeModel.find({ status: { $nin: TEARDOWN_STATUSES } });
    if (found.length === 0) {
      console.log(`${LOG} no data lakes, nothing to do`);
      return;
    }

    // Shortest prefix first, mirroring the reconciler's sort, because each lake's write is visible
    // to the next one's filter. Prefixes can nest (`a:` and `a:x:` both valid, and a cross-scope
    // pair is not a collision), and `a:x:uncategorized` satisfies `a:` - so stamping the inner
    // lake first would leave the outer lake with no node of its own, which is the whole symptom
    // this migration exists to fix.
    const lakes = [...found].sort((a, b) =>
      (normalizeTagPrefix(a.fileTagPrefix) ?? '').localeCompare(normalizeTagPrefix(b.fileTagPrefix) ?? '')
    );

    const skipped: SkippedLake[] = [];
    let stampedFiles = 0;
    let stampedLakes = 0;

    for (const lake of lakes) {
      const decision = await dataLakeService.decideStampPrefix(lake, { dataLakes: dataLakeRepository });

      if (!decision.stamp) {
        skipped.push({ name: lake.name, prefix: lake.fileTagPrefix, why: decision.detail ?? decision.reason });
        continue;
      }

      // THE divergence from the write doors: they stamp anyway when the overlap lookup fails,
      // because a diagnostic read must never fail a user's file write. A bulk mint has the
      // opposite risk profile - it writes across every legacy row at once, and an unverified
      // overlap would hand a whole lake's files to another lake's teardown. Refuse and report;
      // re-running the migration after the read recovers picks the lake back up.
      if (decision.overlapCheckFailed) {
        skipped.push({
          name: lake.name,
          prefix: lake.fileTagPrefix,
          why: 'the prefix-overlap check failed, so an overlap could not be ruled out',
        });
        continue;
      }

      // Meta-tag arm only, NOT the full membership predicate. A prefix-arm member carries a tag
      // under the prefix by definition, and the reconciler returns early for a file with no
      // meta-tag, so widening this would stamp files the live doors never would.
      const result = await FabFile.updateMany(
        { 'tags.name': lake.datalakeTag, ...buildLacksContentPrefixTagFilter(decision.prefix) },
        { $push: { tags: { name: `${decision.prefix}${dataLakeService.UNCATEGORIZED_TAG_SUFFIX}`, strength: 1 } } }
      );

      if (result.modifiedCount > 0) {
        stampedLakes++;
        stampedFiles += result.modifiedCount;
        console.log(
          `${LOG} stamped ${result.modifiedCount} file(s) in "${lake.name}" as ${decision.prefix}${dataLakeService.UNCATEGORIZED_TAG_SUFFIX}`
        );
      }
    }

    console.log(`${LOG} stamped ${stampedFiles} file(s) across ${stampedLakes} lake(s) of ${lakes.length} scanned`);

    if (skipped.length > 0) {
      // These lakes stay uncategorized until someone acts on them, and nothing else will say so -
      // the write doors log the same refusals one file at a time, buried in request logs.
      console.log(`${LOG} skipped ${skipped.length} lake(s); their files stay uncategorized:`);
      for (const lake of skipped) console.log(`  "${lake.name}" (${lake.prefix}): ${lake.why}`);
    }
  },

  // Irreversible on purpose. The stamp this writes is byte-identical to the one the reconciler
  // writes at every write door, and nothing on the tag records which put it there - so a $pull
  // would also strip tags the live doors minted after this ran, re-creating the very symptom on
  // files that were never part of the backfill.
  down: async () => {},
};

export default migration;
