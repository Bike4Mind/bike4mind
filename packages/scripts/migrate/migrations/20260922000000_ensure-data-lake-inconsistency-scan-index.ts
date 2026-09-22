import { DataLakeModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Prepare the lake collection for the scheduled detection sweep: build its staleness-scan index,
 * and strip the findings out of every stored inconsistency summary.
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
 * quotes is destroyed. Every lake scanned before this change still holds those excerpts, and
 * re-scanning is not a fix that can be relied on: a lake that is archived, or below the sweep's
 * ordering for weeks, is never rewritten. So unset the subpath directly. Retention, not tidiness.
 *
 * `$unset` on the subpath rather than a rewrite of the whole field, so the run-level summary the
 * health surface reads (`sampled`, `memberCount`, `countsByKind`) is left exactly as it was. The
 * findings themselves are not lost: every run since the findings model landed has written them as
 * rows as well.
 *
 * Idempotent: createIndexes is a no-op for an index that exists, and `$unset` on an absent path is
 * a no-op too - the filter keeps the write off documents that have nothing to strip.
 */
const migration: MigrationFile = {
  id: 20260922000000,
  name: 'ensure data lake inconsistency scan index and strip stored finding excerpts',

  up: async () => {
    await DataLakeModel.createIndexes();
    await DataLakeModel.collection.updateMany(
      { 'inconsistencyReport.findings': { $exists: true } },
      { $unset: { 'inconsistencyReport.findings': '' } }
    );
  },

  down: async () => {
    // Neither half is reversible, and deliberately so: the index only costs write throughput, and
    // restoring the stripped excerpts would mean re-creating the retention hole this closed. The
    // findings are all still readable as rows.
  },
};

export default migration;
