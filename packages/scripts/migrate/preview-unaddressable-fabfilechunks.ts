import { connectDB, whenCatalogSeeded, mongoose } from '@bike4mind/database';
import { Resource } from 'sst';
import { Config } from '../utils/config';
import { scanUnaddressableChunks } from './unaddressableChunkScan';

/**
 * READ-ONLY preview for 20260911120000_delete-unaddressable-fabfilechunks. Reports what that
 * migration WOULD delete, and issues no write of its own.
 *
 * Its own script rather than a dry-run flag on the migration: the migrator writes the ledger row as
 * soon as `up()` resolves and `selectPending` then skips the id forever, so a flag that returned
 * normally would permanently foreclose the real pass while reporting success - and a flag that threw
 * instead would fail the deploy the migrator gates. Neither is usable. The scan itself is shared
 * (unaddressableChunkScan.ts), so what this prints is what the migration acts on.
 *
 * Exit codes: 0 nothing to delete, 2 rows would be deleted (a finding needing sign-off, not an
 * error), 1 the preview itself failed. Do not read these through `sst shell` or `pnpm --filter`,
 * both of which collapse a non-zero child code to 1 - read the PREVIEW RESULT line instead.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts db:preview-unaddressable-chunks
 */

/** Sample of ids printed per bucket, so a large finding does not bury the summary. */
const SAMPLE_CAP = 50;

const sample = (ids: string[]) =>
  ids.length <= SAMPLE_CAP
    ? ids.join(', ')
    : `${ids.slice(0, SAMPLE_CAP).join(', ')} ... and ${ids.length - SAMPLE_CAP} more`;

async function main(): Promise<number> {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Previewing unaddressable fabfilechunks on stage="${stage}" (read-only)...`);

  const deletableIds: string[] = [];
  const keptIds: string[] = [];
  let scanned = 0;
  let pages = 0;

  for await (const page of scanUnaddressableChunks()) {
    scanned += page.scanned;
    pages += 1;
    deletableIds.push(...page.deletable.map(String));
    keptIds.push(...page.keptIds);
    console.log(
      `  page ${pages}: ${page.scanned} scanned, ${page.deletable.length} deletable, through _id ${page.lastId}`
    );
  }

  console.log('');
  console.log(`Scanned ${scanned} row(s) failing the format gate across ${pages} page(s).`);
  console.log(`WOULD DELETE ${deletableIds.length} row(s): ${deletableIds.length > 0 ? sample(deletableIds) : 'none'}`);
  console.log(
    `WOULD KEEP ${keptIds.length} row(s) whose value still embeds a resolvable file id: ${keptIds.length > 0 ? sample(keptIds) : 'none'}`
  );
  if (keptIds.length > 0) {
    console.log('Those need a human - the chunk may be worth re-pointing at its file rather than dropped.');
  }

  const exitCode = deletableIds.length > 0 ? 2 : 0;
  console.log(
    `PREVIEW RESULT: exit ${exitCode} - ${deletableIds.length} deletable, ${keptIds.length} kept for review, ${scanned} scanned`
  );
  return exitCode;
}

/**
 * `process.exitCode` + an explicit disconnect, never `process.exit()`. Node's stdout is asynchronous
 * when it is a pipe - which the documented `sst shell`/`pnpm` invocation guarantees - and
 * `process.exit()` does not drain it, truncating exactly the summary this script exists to produce.
 */
void (async () => {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    // connectDB (priceCatalogBootstrap) kicks off a fire-and-forget catalog seed. Disconnecting
    // under it throws MongoExpiredSessionError and dumps a stack trace after the report.
    await whenCatalogSeeded().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
})();
