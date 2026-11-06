/**
 * Re-erase accounts that were erased before a database restore point. Every hard delete writes a
 * hash-only ErasureRecord in its own transaction; this script finds users in the target database whose
 * id matches a record and erases them again, repeating what the original path removed and sending no
 * billing, email, analytics or provider-revoke calls. Logic: ./reapplyErasures.ts.
 *
 * The target is the database named by MONGODB_URI (env, else the stage secret): it MUST be the restored
 * cluster. The target host and database are printed at startup; check them before --execute.
 * Dry run by default; pass --execute to write. On --execute the usable records are also copied into the
 * target, so the erasures stay repeatable after the next restore.
 *
 * The records live in the database being restored, so a restore to a point before an erasure loses
 * that erasure's record. Name exactly one source that outlived the restore (there is no default):
 *   --records-uri <mongo uri>   the pre-restore cluster (hosted: point-in-time restores land in a new one);
 *                               the uri must name its database, or add --records-db <name>
 *   --records-file <json>       an export taken before the restore (self-host: mongodump/mongorestore)
 *   --from-target               the target database itself (only if the records survived the restore)
 * A source with 0 records exits non-zero (a wrong source, not a clean restore) unless --allow-empty.
 *
 * Exit code: non-zero if any re-erasure failed or only partly purged (the row is gone, so a re-run will
 * not retry it: clean up by hand), any record was hashed under a different JWT_SECRET (it cannot be
 * matched), or the source was empty. Non-personal organisations left without an owner are listed by id.
 *
 * Hosted flow: restore to a new cluster, then, in an SST shell for that stage with the same JWT_SECRET,
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --records-uri <old cluster uri>
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --records-uri <old cluster uri> --execute
 * Self-host flow: BEFORE the restore, export from the live database; after it, apply the export. The
 * :selfhost script preloads the env-backed `sst` shim, so no SST links are needed; the env must hold
 * MONGODB_URI (the restored database), JWT_SECRET (the one the records were written under),
 * SESSION_SECRET and SECRET_ENCRYPTION_KEY (the shared config module reads them at import):
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures:selfhost --export erasures.json
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures:selfhost --records-file erasures.json --execute
 *
 * Other flags:
 *   --export <json>        write all records (hash-only) from the target to a file and exit
 *   --backfill-from-audit  create records from user.deleted and user.deletion.completed admin audit
 *                          entries whose user no longer exists (--execute to write). Accounts erased
 *                          before audit logging, or through any other path, cannot be recovered.
 *
 * Key rotation: records are hashed with a key derived from JWT_SECRET. After a rotation they no longer
 * match; the script reports them as unmatchable rather than skipping them silently. Run it with the
 * secret that was current when the records were written.
 */

import { readFile } from 'node:fs/promises';
import { connectDB, erasureRecordRepository } from '@bike4mind/database';
import {
  backfillErasureRecords,
  describeMongoTarget,
  exportErasureRecords,
  parseErasureExport,
  parseRecordsSource,
  reapplyErasures,
  reapplyExitCode,
  recordsFromCluster,
} from './reapplyErasures';

/** MONGODB_URI from the env (self-host), else the stage secret; the SST modules load only on that path. */
async function targetUri(): Promise<string> {
  const fromEnv = process.env.MONGODB_URI;
  if (fromEnv && !fromEnv.includes('%STAGE%')) return fromEnv;
  const [{ Resource }, { Config }] = await Promise.all([import('sst'), import('../utils/config')]);
  return (fromEnv ?? Config.MONGODB_URI).replace('%STAGE%', Resource.App.stage);
}

async function main() {
  const argv = process.argv;
  const dryRun = !argv.includes('--execute');
  const exportIndex = argv.indexOf('--export');
  const exportFile = exportIndex === -1 ? undefined : argv[exportIndex + 1];
  if (exportIndex !== -1 && (!exportFile || exportFile.startsWith('--'))) throw new Error('--export needs a file');
  const backfill = argv.includes('--backfill-from-audit');
  // Validate flags before touching any database.
  const source = exportFile || backfill ? undefined : parseRecordsSource(argv);

  const mongoURI = await targetUri();
  console.log(`Target: ${describeMongoTarget(mongoURI)} (must be the restored cluster)`);
  await connectDB(mongoURI);

  if (exportFile) {
    const count = await exportErasureRecords(erasureRecordRepository.cursor(), exportFile);
    console.log(`Exported ${count} erasure record(s) to ${exportFile}`);
    process.exit(0);
  }

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  if (backfill) {
    const r = await backfillErasureRecords({ dryRun, log: console.log });
    console.log(JSON.stringify(r));
    if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
    process.exit(0);
  }

  const records =
    source?.kind === 'uri'
      ? recordsFromCluster(source.uri, source.dbName as string)
      : source?.kind === 'file'
        ? parseErasureExport(await readFile(source.file, 'utf8'))
        : erasureRecordRepository.cursor();

  const result = await reapplyErasures({ records, dryRun, log: console.log });
  console.log(JSON.stringify({ ...result, ownerlessOrganizationIds: undefined }));
  if (result.ownerlessOrganizationIds.length > 0) {
    console.log(`Organizations left without an owner (reassign): ${result.ownerlessOrganizationIds.join(', ')}`);
  }
  if (result.recordsLoaded === 0)
    console.error('The records source yielded 0 records; pass --allow-empty if intended.');
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(reapplyExitCode(result, { allowEmpty: argv.includes('--allow-empty') }));
}

main().catch(error => {
  console.error('[reapply-erasures] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
