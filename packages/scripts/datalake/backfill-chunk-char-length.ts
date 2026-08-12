#!/usr/bin/env tsx
/**
 * One-time backfill for issue #1665: stamp `charLength` onto FabFileChunks, `chunkedCharCount`
 * onto their files, and `totalChunkedChars` onto lakes - the data the lake health predicates
 * (#1666) are computed from. The live write path (chunkFabfile) stamps all three going forward;
 * this trues up documents that predate the fields.
 *
 * Standalone script rather than a migration for the same reason as
 * backfill-chunk-embedding-model.ts: a bounded, one-time sweep over existing data that must not
 * gate a deploy.
 *
 * Three phases, strictly ordered (2 sums what 1 wrote; 3 sums what 2 wrote):
 *   1. Chunks: pipeline update computing $strLenCP('$text') server-side - chunk text never
 *      leaves the database. Same number countCodePoints produces on the write path.
 *   2. Files: chunkedCharCount = sum of the file's chunk charLengths.
 *   3. Lakes: recomputeLakeStats over every non-deleted lake (now carries totalChunkedChars).
 *
 * Idempotent/resumable: phases 1 and 2 only match documents still missing the field, so a rerun
 * after a partial failure picks up where it left off. Phase 3 recomputes unconditionally (cheap:
 * one aggregate + one write per lake) and skips activation - a metadata backfill must not carry
 * the one-way draft -> active publication side effect.
 *
 * Dry-run by default; pass --execute to write.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-chunk-char-length.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/backfill-chunk-char-length.ts --execute
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  connectDB,
  DataLakeModel,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';

interface Options {
  execute: boolean;
  batchSize: number;
}

async function backfillChunks(opts: Options): Promise<number> {
  let processed = 0;
  let afterChunkId: string | undefined;
  for (;;) {
    const ids = await fabFileChunkRepository.findChunkIdsMissingCharLength({
      limit: opts.batchSize,
      afterChunkId,
    });
    if (ids.length === 0) break;
    // The cursor, not the shrinking missing-set, is what terminates a DRY-RUN pass (nothing
    // gets stamped, so the same page would repeat forever without it).
    afterChunkId = ids[ids.length - 1];
    processed += opts.execute ? await fabFileChunkRepository.backfillCharLengthByIds(ids) : ids.length;
    console.log(`  phase 1: ${opts.execute ? 'stamped' : '[dry-run] would stamp'} ${processed} chunk(s) so far`);
  }
  return processed;
}

async function backfillFiles(opts: Options): Promise<number> {
  let processed = 0;
  let afterFileId: string | undefined;
  for (;;) {
    const ids = await fabFileRepository.findFileIdsMissingChunkedCharCount({ limit: 500, afterFileId });
    if (ids.length === 0) break;
    afterFileId = ids[ids.length - 1];
    for (const id of ids) {
      // Dry-run never needs the sum - it only exists to be discarded - so skip the aggregate
      // entirely rather than paying for it on every file in the lake.
      if (opts.execute) {
        const total = await fabFileChunkRepository.sumChunkCharLengthByFabFileId(id);
        await fabFileRepository.setChunkedCharCount(id, total);
      }
      processed++;
    }
    console.log(`  phase 2: ${opts.execute ? 'stamped' : '[dry-run] would stamp'} ${processed} file(s) so far`);
  }
  return processed;
}

async function recomputeLakes(opts: Options): Promise<number> {
  let scanned = 0;
  // Excludes deleting/deleted lakes: phase-1 delete deliberately freezes their stats so a
  // recoverable lake still shows its pre-delete counts (same exclusion as the
  // recompute-stale-datalake-stats migration).
  const cursor = DataLakeModel.find({ status: { $nin: ['deleting', 'deleted'] } }).cursor();
  for await (const lake of cursor) {
    scanned++;
    if (!opts.execute) continue;
    await dataLakeService.recomputeLakeStats(
      lake,
      { db: { dataLakes: dataLakeRepository, fabFiles: fabFileRepository } },
      { skipActivation: true }
    );
  }
  console.log(`  phase 3: ${opts.execute ? 'recomputed' : '[dry-run] would recompute'} ${scanned} lake(s)`);
  return scanned;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);

  console.log('Phase 1: chunk charLength');
  const chunks = await backfillChunks(opts);
  console.log('Phase 2: file chunkedCharCount');
  const files = await backfillFiles(opts);
  console.log('Phase 3: lake totalChunkedChars');
  const lakes = await recomputeLakes(opts);

  console.log(
    `\n${opts.execute ? 'Backfilled' : 'Would backfill'} ${chunks} chunk(s), ${files} file(s); ` +
      `${opts.execute ? 'recomputed' : 'would recompute'} ${lakes} lake(s).`
  );
  return 0;
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 5_000, describe: 'Chunks read per page' })
  .check(checkedArgv => {
    // A batch size of 0 means an unbounded page under Mongo's `.limit()` semantics (0 = no limit),
    // not an empty one - so this must reject rather than silently scanning the whole collection.
    if (checkedArgv['batch-size'] < 1) {
      throw new Error('--batch-size must be at least 1');
    }
    return true;
  })
  .parseSync();

main({ execute: argv.execute, batchSize: argv['batch-size'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
