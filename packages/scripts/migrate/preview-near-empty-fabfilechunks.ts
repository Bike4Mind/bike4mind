import { connectDB, whenCatalogSeeded, mongoose } from '@bike4mind/database';
import { Resource } from 'sst';
import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';
import { Config } from '../utils/config';
import { collectNearEmptyCandidates, planNearEmptyChunkDeletions } from './nearEmptyChunkScan';

/**
 * READ-ONLY preview for 20260915120000_delete-near-empty-vectorized-fabfilechunks. Reports what
 * that migration WOULD delete and repair, and issues no write of its own.
 *
 * Its own script rather than a dry-run flag on the migration, same reasoning as
 * preview-unaddressable-fabfilechunks.ts: the migrator writes the ledger row as soon as `up()`
 * resolves, foreclosing a flag that returned normally without acting. The scan/plan is shared
 * (nearEmptyChunkScan.ts's `collectNearEmptyCandidates`/`planNearEmptyChunkDeletions`), so what
 * this prints is what the migration acts on.
 *
 * Exit codes: 0 nothing to delete, 2 rows would be deleted (a finding needing sign-off, not an
 * error), 1 the preview itself failed. Do not read these through `sst shell` or `pnpm --filter`,
 * both of which collapse a non-zero child code to 1 - read the PREVIEW RESULT line instead.
 *
 * Usage:
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts db:preview-near-empty-chunks
 */

/** Sample of ids printed per bucket, so a large finding does not bury the summary. */
const SAMPLE_CAP = 50;

const sample = (ids: string[]) =>
  ids.length <= SAMPLE_CAP
    ? ids.join(', ')
    : `${ids.slice(0, SAMPLE_CAP).join(', ')} ... and ${ids.length - SAMPLE_CAP} more`;

export async function main(): Promise<number> {
  const dbUri = Config.MONGODB_URI;
  if (!dbUri) throw new Error('MONGODB_URI is required');
  const stage = Resource.App.stage;
  await connectDB(dbUri.replace('%STAGE%', stage));

  console.log(`Previewing near-empty vectorized fabfilechunks on stage="${stage}" (read-only)...`);

  const { candidatesByFile, scanned, pages } = await collectNearEmptyCandidates(info => {
    // `info.scanned` is the CUMULATIVE count across every page so far, not this page's count -
    // reads correctly even mid-scan, unlike a per-page number that would look stalled.
    console.log(`  page ${info.pages}: ${info.scanned} scanned so far, through _id ${info.lastId}`);
  });

  const plans = await planNearEmptyChunkDeletions(candidatesByFile);
  const deletableIds = plans.flatMap(p => p.deletableIds.map(String));
  const keptSoleChunkIds = plans.filter(p => p.keptSoleChunkId).map(p => String(p.keptSoleChunkId));
  const filesWithDeletions = plans.filter(p => p.deletableIds.length > 0).length;

  console.log('');
  console.log(
    `Scanned ${scanned} near-empty vector-bearing row(s) across ${candidatesByFile.size} file(s) (${pages} page(s)).`
  );
  console.log(
    `WOULD DELETE ${deletableIds.length} row(s) across ${filesWithDeletions} file(s): ${
      deletableIds.length > 0 ? sample(deletableIds) : 'none'
    }`
  );
  console.log(
    `WOULD KEEP ${keptSoleChunkIds.length} row(s) as the sole surviving chunk of an otherwise fully-degenerate file: ${
      keptSoleChunkIds.length > 0 ? sample(keptSoleChunkIds) : 'none'
    }`
  );

  const exitCode = deletableIds.length > 0 ? 2 : 0;
  console.log(
    `PREVIEW RESULT: exit ${exitCode} - ${deletableIds.length} deletable, ${keptSoleChunkIds.length} kept as sole chunk, ${scanned} scanned`
  );
  return exitCode;
}

// realpath-resolved, not the naive `file://${process.argv[1]}` comparison: Node canonicalizes
// import.meta.url but argv[1] is the raw string, so an invocation through a symlink (macOS's
// /tmp -> /private/tmp) would silently skip the block and exit 0 having done nothing.
const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

/**
 * `process.exitCode` + an explicit disconnect, never `process.exit()`. Node's stdout is asynchronous
 * when it is a pipe - which the documented `sst shell`/`pnpm` invocation guarantees - and
 * `process.exit()` does not drain it, truncating exactly the summary this script exists to produce.
 */
if (isMainModule)
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
