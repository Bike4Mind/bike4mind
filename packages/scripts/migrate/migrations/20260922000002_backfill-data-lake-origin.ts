import { DataLakeModel, OrgGoogleDriveConnection } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[backfill-data-lake-origin]';

/**
 * Backfill `origin` on lakes that predate the field, so unattended ingest enforcement has
 * something to read. A lake that a connector feeds is `connector-fed`; everything else is
 * `curated` (the schema default, so only the former needs writing).
 *
 * Presence of a connection row is the WHOLE test, deliberately. Do not add `enabled: true` or
 * `status: 'connected'`:
 *   - Disconnecting hard-deletes the row (release() runs deleteMany, because a surviving row would
 *     keep the unique driveFolderId claim populated and block re-claim), so a stale row cannot exist.
 *   - `enabled: false` means the LAKE is archived or soft-deleted - archiveDataLake/deleteDataLake
 *     call disableDriveConnectionForLake, and unarchive/restore reverse it. Excluding those lakes
 *     would mark them curated and then refuse the connector the moment someone restores them.
 *   - 'needs_reconnect' and 'credential_error' are broken credentials on an intentional binding that
 *     a reconnect repairs.
 *
 * Idempotent: only writes lakes with no origin yet, so a re-run is a no-op. Must run before, or as
 * part of, the deploy that ships the field: Mongoose stamps the schema default onto any hydrated
 * lake document a later save touches, so a lake saved by app code after deploy but before this
 * migration runs acquires a stored origin and becomes permanently unrepairable by the
 * `$exists: false` filter below.
 */
const migration: MigrationFile = {
  id: 20260922000002,
  name: 'backfill-data-lake-origin',

  up: async () => {
    const lakeIds = await OrgGoogleDriveConnection.distinct('targetDataLakeId');
    // $exists: false, not $ne: 'connector-fed' - a lake an owner deliberately demoted back to
    // curated already has an origin stored (just not that value), and $ne would re-promote it on
    // every re-run. Only a pre-field document has no origin key at all, which is the one case this
    // migration is meant to touch.
    const result = await DataLakeModel.updateMany(
      { _id: { $in: lakeIds }, origin: { $exists: false } },
      { $set: { origin: 'connector-fed' } }
    );
    console.log(`${LOG} ${lakeIds.length} connected lake(s); ${result.modifiedCount} marked connector-fed`);
  },

  // Scoped to the same connection-backed set `up` writes, not every connector-fed lake: a lake
  // promoted by its owner's own action (not this migration) must survive a rollback of the code
  // that shipped `origin`. Lossy for a manual promotion that ALSO has a live Drive connection - it
  // reverts to curated same as the backfilled ones - but that is the normal rollback shape (code
  // still deployed, Drive ingest/binding switched off across the install), not scoped further.
  down: async () => {
    const lakeIds = await OrgGoogleDriveConnection.distinct('targetDataLakeId');
    const result = await DataLakeModel.updateMany(
      { _id: { $in: lakeIds }, origin: 'connector-fed' },
      { $set: { origin: 'curated' } }
    );
    console.log(`${LOG} down: reset ${result.modifiedCount} lake(s) to curated`);
  },
};

export default migration;
