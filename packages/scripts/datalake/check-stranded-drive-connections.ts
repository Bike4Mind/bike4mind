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

  // Neither model registers softDeletePlugin, so every row is a live row: scan them all, and read
  // the connection rather than the lake for the org, since the lake document is the thing that may
  // be gone.
  const connections = await OrgGoogleDriveConnection.find(
    {},
    'organizationId driveFolderId targetDataLakeId connectedBy folderName'
  );
  // A lake in `deleted`/`purging` is NOT stranded: findById returns it regardless of status, so the
  // drive-connection route can still reach and release its connection. Only a missing lake document
  // leaves the row unreachable.
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
        `lake=${c.targetDataLakeId} <missing> connectedBy=${c.connectedBy}`
    );
  }

  if (!release) {
    console.log('\nRe-run with --release to hard-delete these rows and free their folder claims.');
    console.log('Then ask each connectedBy user to revoke the grant from their own Google account page.');
    process.exit(1);
  }

  const res = await OrgGoogleDriveConnection.deleteMany({ _id: { $in: stranded.map(c => c._id) } });
  console.log(`\nReleased ${res?.deletedCount ?? 0} row(s). Those Drive folders can now be connected again.`);
  console.log('The Google grants are NOT revoked - each connectedBy user must revoke from their own account.');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
