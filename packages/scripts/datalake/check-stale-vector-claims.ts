#!/usr/bin/env tsx
/**
 * Report-only detection sweep for #2583: a file whose `vectorizedChunkCount > 0` but which has
 * ZERO rows in fabfilechunks. Such a file is unretrievable by both read paths (the ANN index has
 * nothing for it, the brute-force scan finds no vectors to score) while every counter-based health
 * surface reads it as vectorized - a stale count left behind by an interrupted chunk/file delete
 * (see purgeDataLakeDocument.ts, cleanupDeletedDataLake.ts, ingestHelpDatalake.ts and
 * retrieval/supersession-probe.ts, all fixed to order the two writes the other way as of this issue,
 * so this should only ever report pre-existing damage going forward).
 *
 * Deliberately NOT wired into GET /api/data-lakes/:id/health (computeLakeHealth.ts): that endpoint
 * is read-gated for any lake reader and is documented to NEVER scan the chunk collection (#1665 -
 * one staging file alone carries 13k+ chunks). The check here is cheap PER CANDIDATE (an
 * index-covered $group on `{fabFileId:1,_id:1}`, no chunk content read), but it is still a chunk-
 * collection read over however many files declare a positive count - fine for an operator-run,
 * bounded, one-off sweep; not something every page load should pay for. Same posture as
 * detectLakeInconsistencies, which is also owner/operator-triggered for the same reason.
 *
 * Standalone script rather than a queue/migration: bounded, one-time detection over existing data,
 * not an ongoing pipeline stage. Report-only BY DEFAULT; `--repair` opts into the write, which is
 * `resetChunkStateByIds` over the flagged ids - see `repairStaleVectorClaims` for why that single
 * reset covers the lake members too, rather than this script re-implementing a re-vectorize.
 *
 * The `system-help` slice of the population does not need `--repair`: the help mirror's reuse gate
 * now consults chunk rows (ingestHelpDatalake.ts), so its members are re-created on the next
 * 6-hourly tick and stay self-healing against any future source of this state.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/check-stale-vector-claims.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/check-stale-vector-claims.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/check-stale-vector-claims.ts --repair
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository, fabFileRepository } from '@bike4mind/database';
import { collectStaleVectorClaims, repairStaleVectorClaims } from './collectStaleVectorClaims';

interface Options {
  batchSize: number;
  repair: boolean;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}).`);

  // The sweep itself lives in collectStaleVectorClaims.ts so it can be tested without a DB; this
  // file stays the connection, the argv and the reporting.
  const { scanned, stale } = await collectStaleVectorClaims(
    {
      findFileIdsWithPositiveVectorizedCount: options =>
        fabFileRepository.findFileIdsWithPositiveVectorizedCount(options),
      findFabFileIdsWithChunks: ids => fabFileChunkRepository.findFabFileIdsWithChunks(ids),
    },
    { batchSize: opts.batchSize }
  );

  console.log(`Scanned ${scanned} file(s) declaring a vectorized chunk count.`);
  if (stale.length === 0) {
    console.log('None are stale: every declared count has at least one chunk row behind it.');
    return 0;
  }

  console.log(`Found ${stale.length} file(s) declaring vectorized chunks they do not have:`);
  for (const file of stale) {
    console.log(`  id=${file.id} fileName=${JSON.stringify(file.fileName ?? '')}`);
  }

  if (!opts.repair) {
    console.log(
      '\nThese are unretrievable by both read paths but read as vectorized by every counter-based ' +
        'health surface. Re-run with --repair to reset them.'
    );
    return 1;
  }

  const { reset, skipped } = await repairStaleVectorClaims(
    { resetChunkStateByIds: ids => fabFileRepository.resetChunkStateByIds(ids) },
    stale.map(file => file.id)
  );
  console.log(`\nReset ${reset.length} of ${stale.length} file(s); their counters no longer claim chunks.`);
  if (skipped.length === 0) {
    console.log('Any that are lake members are now offered the "Rebuild passages" repair on their lake.');
    return 0;
  }

  // Not an error: the reset is preconditioned on `isChunking: {$ne: true}`, so a file a worker
  // holds is left to that worker. It is reported, and a re-run picks up whatever is still stale.
  console.log(`Skipped ${skipped.length} held by an in-flight chunk worker; re-run to pick them up:`);
  for (const id of skipped) console.log(`  id=${id}`);
  return 1;
}

const argv = yargs(hideBin(process.argv))
  .option('batch-size', { type: 'number', default: 2_000, describe: 'Candidate files read per page' })
  .option('repair', { type: 'boolean', default: false, describe: 'Reset the flagged files (writes)' })
  .parseSync();

main({ batchSize: argv['batch-size'], repair: argv.repair })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
