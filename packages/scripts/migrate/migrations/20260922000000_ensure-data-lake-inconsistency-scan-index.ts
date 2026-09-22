import { DataLakeModel, dataLakeFindingRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import type { InconsistencyFinding } from '@bike4mind/common';
import { type MigrationFile } from './index';

/**
 * Prepare the lake collection for the scheduled detection sweep: build its staleness-scan index,
 * backfill any legacy blob findings onto rows, then strip the findings out of the stored summary.
 *
 * INDEX. The sweep pages over active lakes ordered by `lastInconsistencyScanAt`, and
 * `{status, lastInconsistencyScanAt, _id}` is what serves that sort. Without it every page of a
 * fleet-wide scan pays a blocking top-k sort over all active lakes - and unlike the caller-facing
 * route this runs unattended, so nobody is watching the latency it would spend. Migration rather
 * than autoIndex for the reasons the sibling ensure-*-index migrations give: `mongo.ts` fires
 * autoIndex without awaiting it, so a failed build is silent, and on DocumentDB a build takes a
 * foreground collection lock - taken by whichever Lambda cold-boots first, i.e. a user's request.
 *
 * BACKFILL. `inconsistencyReport` now stores the run's summary and never its findings, because a
 * finding carries a 240-char excerpt of each source document and the purge-time sweeps that
 * discharge that obligation reach the FINDING ROWS only - nothing rewrites a blob when a document it
 * quotes is destroyed. The row-writing path only exists since the findings model landed; the
 * blob-only detector shipped over two weeks earlier, so a lake scanned in that window has excerpts
 * in the blob and no row behind them. Re-scanning is not a fix that can be relied on to close that
 * gap: a lake that is archived, or sitting below the sweep's staleness ordering for weeks, is never
 * rewritten while its owner can still read the stale blob. So this migration writes the missing rows
 * itself, through the same `recordLakeFindings` door every detector run uses - `lexical` is the only
 * detector that ever existed before this migration, so it is the correct attribution for every
 * legacy finding. Only then does it unset the blob's `findings` subpath; a lake that had no findings
 * to backfill still gets the `$unset` pass, harmlessly, since it never had the field to begin with.
 *
 * `$unset` on the subpath rather than a rewrite of the whole field, so the run-level summary the
 * health surface reads (`sampled`, `memberCount`, `countsByKind`) is left exactly as it was.
 *
 * Idempotent: createIndexes is a no-op for an index that exists, `recordDetected` is an upsert keyed
 * on (lakeId, detector, kind, subject) so re-running the backfill converges on the same rows instead
 * of duplicating them, and `$unset` on an absent path is a no-op too - the filter keeps the write off
 * documents that have nothing left to strip.
 */
const migration: MigrationFile = {
  id: 20260922000000,
  name: 'ensure data lake inconsistency scan index and strip stored finding excerpts',

  up: async () => {
    await DataLakeModel.createIndexes();

    const lakes = await DataLakeModel.collection
      .find(
        { 'inconsistencyReport.findings': { $exists: true } },
        { projection: { _id: 1, inconsistencyReport: 1, inconsistencyComputedAt: 1 } }
      )
      .toArray();

    for (const lake of lakes) {
      const findings = (lake.inconsistencyReport?.findings ?? []) as InconsistencyFinding[];
      // `seenAt` mirrors what the blob-only route stamped alongside these findings when it wrote
      // them, so a backfilled row's `firstSeenAt`/`lastSeenAt` reads as "as of the last real scan"
      // rather than "as of the migration". Falls back to now only for the shape the destructive-case
      // test does not otherwise cover: a report with findings but no computed date.
      const seenAt = (lake.inconsistencyComputedAt as Date | undefined) ?? new Date();
      if (findings.length > 0) {
        await dataLakeService.recordLakeFindings(
          String(lake._id),
          findings,
          { detector: dataLakeService.INCONSISTENCY_DETECTOR, seenAt },
          { db: { dataLakeFindings: dataLakeFindingRepository } }
        );
      }
    }

    await DataLakeModel.collection.updateMany(
      { 'inconsistencyReport.findings': { $exists: true } },
      { $unset: { 'inconsistencyReport.findings': '' } }
    );
  },

  down: async () => {
    // Neither half is reversible, and deliberately so: the index only costs write throughput, and
    // restoring the stripped excerpts would mean re-creating the retention hole this closed. The
    // findings are all still readable as rows - the backfill above is what guarantees that for the
    // lakes that had none until now.
  },
};

export default migration;
