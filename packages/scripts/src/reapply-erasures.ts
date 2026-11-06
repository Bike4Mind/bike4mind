#!/usr/bin/env tsx

/**
 * Re-erase accounts that were erased before a database restore point. Every hard delete writes a
 * hash-only ErasureRecord in its own transaction; this script finds users in the target database whose
 * id matches a record and erases them again, repeating what the original path removed and sending no
 * billing, email, analytics or provider-revoke calls. Logic: ./reapplyErasures.ts.
 *
 * Dry run by default; pass --execute to write. Exits non-zero if any re-erasure failed or any record
 * was hashed under a different JWT_SECRET (it cannot be matched).
 *
 * The records live in the database being restored, so a restore to a point before an erasure loses
 * that erasure's record. Read them from somewhere that outlived the restore:
 *   --records-uri <mongo uri>   the pre-restore cluster (hosted: point-in-time restores land in a new one)
 *   --records-file <json>       an export taken before the restore (self-host: mongodump/mongorestore)
 * With neither, records come from the target database itself.
 *
 * Hosted flow: restore to a new cluster, then, in an SST shell for that stage with the same JWT_SECRET,
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --records-uri <old cluster uri>
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --records-uri <old cluster uri> --execute
 * Self-host flow: BEFORE the restore, export from the live database; after it, apply the export:
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --export erasures.json
 *   pnpm --filter @bike4mind/scripts db:reapply-erasures --records-file erasures.json --execute
 *
 * Other flags:
 *   --export <json>        write all records (hash-only) to a file and exit
 *   --backfill-from-audit  create records from user.deleted and user.deletion.completed admin audit
 *                          entries whose user no longer exists (--execute to write). Accounts erased
 *                          before audit logging, or through any other path, cannot be recovered.
 *
 * Key rotation: records are hashed with a key derived from JWT_SECRET. After a rotation they no longer
 * match; the script reports them as unmatchable rather than skipping them silently. Run it with the
 * secret that was current when the records were written.
 */

import { readFile } from 'node:fs/promises';
import mongoose from 'mongoose';
import { connectDB, ErasureRecordModel, erasureRecordRepository, type IErasureRecord } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import {
  backfillErasureRecords,
  erasureRecordSchema,
  exportErasureRecords,
  parseErasureExport,
  reapplyErasures,
} from './reapplyErasures';

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function* recordsFromCluster(uri: string): AsyncGenerator<IErasureRecord> {
  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const cursor = conn.collection(ErasureRecordModel.collection.name).find({}, { projection: { _id: 0 } });
    for await (const doc of cursor) yield erasureRecordSchema.parse(doc);
  } finally {
    await conn.close();
  }
}

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const mongoURI = process.env.MONGODB_URI ?? Config.MONGODB_URI;
  await connectDB(mongoURI.replace('%STAGE%', Resource.App.stage));

  const exportFile = flag('--export');
  if (exportFile) {
    const count = await exportErasureRecords(erasureRecordRepository.cursor(), exportFile);
    console.log(`Exported ${count} erasure record(s) to ${exportFile}`);
    process.exit(0);
  }

  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  if (process.argv.includes('--backfill-from-audit')) {
    const r = await backfillErasureRecords({ dryRun, log: console.log });
    console.log(JSON.stringify(r));
    if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
    process.exit(0);
  }

  const recordsUri = flag('--records-uri');
  const recordsFile = flag('--records-file');
  const records = recordsUri
    ? recordsFromCluster(recordsUri)
    : recordsFile
      ? parseErasureExport(await readFile(recordsFile, 'utf8'))
      : erasureRecordRepository.cursor();

  const result = await reapplyErasures({ records, dryRun, log: console.log });
  console.log(JSON.stringify(result));
  if (dryRun) console.log('Dry run only. Re-run with --execute to apply.');
  process.exit(result.failed > 0 || result.unmatchableKey > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('[reapply-erasures] failed:', error);
  process.exit(1);
});
