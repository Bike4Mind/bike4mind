#!/usr/bin/env tsx
/**
 * Report-only detection sweep for #2583: a file whose `vectorizedChunkCount > 0` but which has
 * ZERO rows in fabfilechunks. Such a file is unretrievable by both read paths (the ANN index has
 * nothing for it, the brute-force scan finds no vectors to score) while every counter-based health
 * surface reads it as vectorized - a stale count left behind by an interrupted chunk/file delete
 * (see purgeDataLakeDocument.ts, cleanupDeletedDataLake.ts, ingestHelpDatalake.ts, all fixed to
 * order the two writes the other way as of this issue, so this should only ever report pre-existing
 * damage going forward).
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
 * not an ongoing pipeline stage. Report-only - repairing the flagged population (re-vectorize the
 * ones still in a lake, `resetChunkStateByIds` the rest) is deliberately out of scope here.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/check-stale-vector-claims.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/check-stale-vector-claims.ts
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository, fabFileRepository } from '@bike4mind/database';

interface Options {
  batchSize: number;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}).`);

  let afterFileId: string | undefined;
  let scanned = 0;
  const stale: { id: string; fileName?: string }[] = [];

  for (;;) {
    const page = await fabFileRepository.findFileIdsWithPositiveVectorizedCount({
      limit: opts.batchSize,
      afterFileId,
    });
    if (page.length === 0) break;
    afterFileId = page[page.length - 1].id;
    scanned += page.length;

    const withChunks = await fabFileChunkRepository.findFabFileIdsWithChunks(page.map(f => f.id));
    for (const file of page) {
      if (!withChunks.has(file.id)) stale.push(file);
    }
  }

  console.log(`Scanned ${scanned} file(s) declaring a vectorized chunk count.`);
  if (stale.length === 0) {
    console.log('None are stale: every declared count has at least one chunk row behind it.');
    return 0;
  }

  console.log(`Found ${stale.length} file(s) declaring vectorized chunks they do not have:`);
  for (const file of stale) {
    console.log(`  id=${file.id} fileName=${JSON.stringify(file.fileName ?? '')}`);
  }
  console.log(
    '\nThese are unretrievable by both read paths but read as vectorized by every counter-based ' +
      'health surface. Repair is a separate, deliberate follow-up - see #2583.'
  );
  return 1;
}

const argv = yargs(hideBin(process.argv))
  .option('batch-size', { type: 'number', default: 2_000, describe: 'Candidate files read per page' })
  .parseSync();

main({ batchSize: argv['batch-size'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
