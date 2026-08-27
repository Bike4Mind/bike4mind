import { connectDB, DataLakeModel, OrgGoogleDriveConnection } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';

/**
 * Find (and optionally release) OrgGoogleDriveConnection rows whose target data lake no longer
 * exists.
 *
 * Such a row is unreachable by any product surface: the only route to a disconnect resolves the
 * connection THROUGH its lake, so once the lake document is gone the row can never be released - and
 * because `driveFolderId` is globally unique, its Drive folder can never be connected to a lake
 * again, by anyone. The purge sweep now releases the connection itself, so this is the one-off
 * cleanup for rows stranded before that landed.
 *
 * `--release` HARD-deletes the reported rows, which frees the folder claim. It deliberately does NOT
 * revoke the credential at Google: the encrypted refresh token is usually the connecting user's own
 * personal Drive token (drive-sync copies it verbatim), and revoking it from a batch job would kill
 * that user's personal Drive with no way to tell which rows are safe. Ask each `connectedBy` user to
 * revoke from their own Google account page, or from Profile -> Connected Apps -> Google Drive.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts datalake:check-stranded-drive-connections
 *   ... datalake:check-stranded-drive-connections -- --release
 */
async function main() {
  const release = process.argv.includes('--release');
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  // includeDeleted on the CONNECTIONS: a soft-deleted row still occupies the unique driveFolderId
  // index, so it blocks re-claim exactly like a live one while being invisible to every accessor.
  // No writer soft-deletes these today (release() hard-deletes), but a row that got there some other
  // way is precisely what this scan is for.
  const connections = await OrgGoogleDriveConnection.find(
    {},
    'organizationId driveFolderId targetDataLakeId connectedBy folderName deletedAt',
    { includeDeleted: true }
  );
  // LAKES are read with the default soft-delete filter on purpose: a lake the plugin hides is
  // already unreachable from the drive-connection route (which resolves through findById), so its
  // connection is stranded whether the document is gone or merely stamped.
  const lakeIds = new Set(
    (await DataLakeModel.find({ _id: { $in: connections.map(c => c.targetDataLakeId) } }, '_id')).map(l =>
      String(l._id)
    )
  );
  const stranded = connections.filter(c => !lakeIds.has(c.targetDataLakeId));

  console.log(`Scanned ${connections.length} Google Drive connection(s) on stage="${stage}".`);
  if (stranded.length === 0) {
    console.log('No stranded connections: every row still points at a live data lake.');
    process.exit(0);
  }

  console.log(`Found ${stranded.length} stranded connection(s) - their Drive folders are unclaimable:`);
  for (const c of stranded) {
    console.log(
      `  id=${c.id} org=${c.organizationId} folder=${c.driveFolderId} (${c.folderName ?? 'unnamed'}) ` +
        `lake=${c.targetDataLakeId} <missing> connectedBy=${c.connectedBy}` +
        (c.get('deletedAt') ? ' [row itself soft-deleted, still holding the index]' : '')
    );
  }

  if (!release) {
    console.log('\nRe-run with --release to hard-delete these rows and free their folder claims.');
    console.log('Then ask each connectedBy user to revoke the grant from their own Google account page.');
    process.exit(1);
  }

  const res = await OrgGoogleDriveConnection.deleteMany(
    { _id: { $in: stranded.map(c => c._id) } },
    { hardDelete: true }
  );
  console.log(`\nReleased ${res?.deletedCount ?? 0} row(s). Those Drive folders can now be connected again.`);
  console.log('The Google grants are NOT revoked - each connectedBy user must revoke from their own account.');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
