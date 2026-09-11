#!/usr/bin/env tsx
/**
 * One-time backfill: stamp `embeddingModel` onto FabFileChunks that predate the write-path
 * change which stamps it going forward (see `stampChunkEmbeddingModel`,
 * apps/client/server/queueHandlers/fabFileVectorize.ts). The Atlas `$vectorSearch` cutover
 * needs every vectorized chunk labelled with the model it was embedded under - an unlabeled
 * chunk is invisible to a model-scoped query and permanently falls back to the brute-force scan.
 *
 * Standalone script rather than a queue/migration: this is a bounded, one-time sweep over
 * existing data, not an ongoing pipeline stage, and does not need to block a deploy the way a
 * migration does (see MigrationManager.up).
 *
 * Groups chunks missing the field by file, resolves each file's model (its own
 * `FabFile.embeddingModel` when known, else a guess from its chunks' own vector width - see
 * backfillPlan.ts), then calls the SAME `stampChunkEmbeddingModel` helper the live write path
 * uses. Idempotent/resumable: `findChunksMissingEmbeddingModel` only returns chunks still
 * missing the field, so stamping a file removes it from every later page and a rerun after a
 * partial failure picks up exactly where it left off.
 *
 * Dry-run by default; pass --execute to write.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/backfill-chunk-embedding-model.ts
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/backfill-chunk-embedding-model.ts --execute
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import mongoose from 'mongoose';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository, fabFileRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { planFileBackfills } from './backfillPlan.js';

interface Options {
  execute: boolean;
  batchSize: number;
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);
  console.log(`Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);

  let afterChunkId: string | undefined;
  let stampedFiles = 0;
  let stampedChunks = 0;
  const unresolvedFiles = new Set<string>();
  const unaddressableFileIds = new Set<string>();

  for (;;) {
    const missing = await fabFileChunkRepository.findChunksMissingEmbeddingModel({
      limit: opts.batchSize,
      afterChunkId,
    });
    if (missing.length === 0) break;
    afterChunkId = missing[missing.length - 1].id;

    const fileIds = [...new Set(missing.map(c => c.fabFileId))];

    // `fabFileId` is declared as a plain String, so a legacy chunk can hold a value that cannot
    // address a row by `_id` (observed on real data: a stringified FabFile document). Handing one
    // to `findById` throws a CastError that rejects the whole `Promise.all`, and since the cursor
    // is in-process a rerun restarts on the same page - so a single bad row blocks the entire
    // backfill permanently rather than costing one file. Same rationale, and the same
    // `isObjectIdOrHexString` over `isValidObjectId` choice, as `usableObjectIds` in
    // b4m-core/db-core/src/utils/mongo.ts.
    const addressableIds = new Set(fileIds.filter(id => mongoose.isObjectIdOrHexString(id)));
    for (const id of fileIds) if (!addressableIds.has(id)) unaddressableFileIds.add(id);

    // Planning is filtered too, not just the lookup: `planFileBackfills` would otherwise guess a
    // model from vector width for one of these and hand `stampChunkEmbeddingModel` an id it cannot
    // write, moving the same crash one step later.
    const stampable = missing.filter(c => addressableIds.has(c.fabFileId));
    const lookupIds = [...addressableIds];
    const files = await Promise.all(lookupIds.map(id => fabFileRepository.findById(id)));
    const fileEmbeddingModels = new Map(lookupIds.map((id, i) => [id, files[i]?.embeddingModel]));

    const { plans, unresolved } = planFileBackfills(stampable, fileEmbeddingModels);

    for (const plan of plans) {
      if (opts.execute) {
        await fabFilesService.stampChunkEmbeddingModel(plan.fabFileId, plan.embeddingModel, {
          db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository },
        });
      }
      stampedFiles++;
      stampedChunks += plan.chunkCount;
      console.log(
        `${opts.execute ? 'Stamped' : '[dry-run] Would stamp'} file ${plan.fabFileId} -> ${plan.embeddingModel} (${plan.chunkCount} chunk(s))`
      );
    }

    for (const fileId of unresolved) unresolvedFiles.add(fileId);
  }

  console.log(`\n${opts.execute ? 'Stamped' : 'Would stamp'} ${stampedFiles} file(s), ${stampedChunks} chunk(s).`);
  if (unresolvedFiles.size > 0) {
    console.warn(
      `\n${unresolvedFiles.size} file(s) could not be resolved to a model (mixed-width or unknown vector width) and were skipped:`
    );
    for (const fileId of unresolvedFiles) console.warn(`  UNRESOLVED ${fileId}`);
    console.warn('These remain unlabeled and will keep falling back to the brute-force scan.');
  }
  if (unaddressableFileIds.size > 0) {
    console.warn(
      `\n${unaddressableFileIds.size} chunk fabFileId value(s) are not ObjectIds and cannot address a file. ` +
        'These need data repair; this script cannot stamp them:'
    );
    // Truncated: an unaddressable value is not necessarily short - the ones observed in practice
    // are a whole serialized document, which would bury the rest of this summary.
    for (const fileId of unaddressableFileIds) {
      const shown = fileId.length > 60 ? `${fileId.slice(0, 60)}... (${fileId.length} chars)` : fileId;
      console.warn(`  UNADDRESSABLE ${JSON.stringify(shown)}`);
    }
  }
  return unresolvedFiles.size > 0 || unaddressableFileIds.size > 0 ? 1 : 0;
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 5_000, describe: 'Chunks read per page' })
  .parseSync();

main({ execute: argv.execute, batchSize: argv['batch-size'] })
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
