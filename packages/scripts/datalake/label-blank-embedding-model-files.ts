#!/usr/bin/env tsx
/**
 * One-time repair: write the FILE-level `embeddingModel` label onto vectorized files that carry
 * none, so the default-model flip does not strand them.
 *
 * Why a blank file label is not harmless once the default moves. `isForeignEmbeddingModel` never
 * excludes a blank label, so today these files still answer queries - but two readers already treat
 * blank as unreachable rather than as "unknown": `lakeSourceReachability` requires an exact
 * file-label match, so `recallLakeMemory` drops the beliefs citing them, and the attachment scan in
 * llm/utils keys its query vector off the file label defaulted to ada-002. The moment the
 * deployment default is something else, that lookup misses for every unlabeled file. Labeling them
 * with the model their vectors are ACTUALLY in is what keeps them answering across the flip, which
 * is why this has to complete BEFORE the default changes and not after.
 *
 * Distinct from backfill-chunk-embedding-model.ts and NOT covered by it. That script pages CHUNKS
 * missing a label and never passes `stampFile`, so the bulk of this population - files whose chunks
 * are already fully labeled and only the file row is blank - never enters its result set at all.
 *
 * `stampFile` is normally the vectorize handler's alone, because a file label is exclusion
 * AUTHORITY: wrong, it drops a healthy file from search wholesale and sends the operator to
 * re-embed it. This pass is allowed to write one only where the label is READ from the file's own
 * chunk labels rather than guessed, or where the vectors are unlabeled but all of the one width
 * whose attribution comes from deployment history - see ATTRIBUTABLE_VECTOR_WIDTH in
 * labelBlankFilesPlan.ts, which is also where that exemption's expiry condition is written down.
 * Every other shape is skipped and reported, never guessed.
 *
 * `--model` is required and is checked, not trusted: a file whose chunks declare only some OTHER
 * model is skipped as `foreign-chunk-label`, and a first page that resolves nothing but those
 * aborts before any write (see the wrong-model guard in main). That is the difference between a
 * mistyped model doing nothing and a mistyped model excluding the corpus.
 *
 * Idempotent and resumable: a stamped file leaves `findVectorizedFilesMissingEmbeddingModel`'s
 * filter immediately, so a rerun after a partial failure picks up what is still blank. Skipped
 * files stay in the set and are re-examined on every run, which is intended - they are a standing
 * report, not a queue this pass can drain.
 *
 * Reversible, which is why the rollback record is written BEFORE the writes it describes. Every
 * stamped id goes to --rollback-log paired with the fields an unwind must clear, because neither the
 * set nor the field list is recoverable after the fact: a stamped file leaves the finder's filter,
 * so once the pass has run nothing can be asked which files it labeled. See rollbackLogLines in
 * labelBlankFilesPlan.ts for why the field list is per file and not global.
 *
 * Dry-run by default; pass --execute to write.
 *
 * Usage (needs DB, provided by `sst shell`):
 *   npx sst shell --stage dev        -- tsx packages/scripts/datalake/label-blank-embedding-model-files.ts --model text-embedding-ada-002
 *   npx sst shell --stage production -- tsx packages/scripts/datalake/label-blank-embedding-model-files.ts --model text-embedding-ada-002 --execute
 */

import { appendFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository, fabFileRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import {
  planFileLabels,
  rollbackLogLines,
  type FileLabelCandidate,
  type SkipReason,
} from './labelBlankFilesPlan.js';

interface Options {
  execute: boolean;
  batchSize: number;
  model: string;
  rollbackLog: string;
}

/** Read the per-file evidence the label decision needs. One file at a time: the population is small
 *  and each read is a different collection scoped to one id, so batching buys little and would
 *  duplicate the three filters these methods own. */
async function readEvidence(file: {
  id: string;
  chunkEmbeddingModelStampedAt: Date | null;
}): Promise<FileLabelCandidate> {
  const [declaredModels, unlabeledVectorChunks] = await Promise.all([
    fabFileChunkRepository.distinctEmbeddingModelsByFabFileId(file.id),
    fabFileChunkRepository.countUnlabeledVectorChunksByFabFileId(file.id),
  ]);
  // Only read when the decision will rest on it. A file whose chunks are all labeled is attributed
  // by those labels, and consulting width there would skip files the labels already settle.
  const unlabeledVectorWidths =
    unlabeledVectorChunks > 0 ? await fabFileChunkRepository.distinctUnlabeledVectorWidthsByFabFileId(file.id) : [];
  return {
    id: file.id,
    chunkEmbeddingModelStampedAt: file.chunkEmbeddingModelStampedAt,
    declaredModels,
    unlabeledVectorChunks,
    unlabeledVectorWidths,
  };
}

async function main(opts: Options): Promise<number> {
  const dbUri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(dbUri);

  const before = await fabFileRepository.countVectorizedFilesMissingEmbeddingModel();
  console.log(
    `Connected (stage: ${Resource.App.stage}), mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}, model: ${opts.model}`
  );
  console.log(`${before} vectorized file(s) currently carry no file-level label.`);

  let afterFileId: string | undefined;
  let stamped = 0;
  let deletedStamped = 0;
  let firstPage = true;
  const skipsByReason = new Map<SkipReason, string[]>();
  const rollbackIds: string[] = [];

  // APPENDED, never truncated. This script is resumable, so the run that finishes the job is often
  // not the one that stamped most of it - truncating here would discard the earlier run's ids while
  // leaving its writes in place, which is precisely the partial-failure case the log exists for.
  if (opts.execute) {
    appendFileSync(
      opts.rollbackLog,
      `# run ${new Date().toISOString()} stage=${Resource.App.stage} model=${opts.model}\n`
    );
  }

  for (;;) {
    const page = await fabFileRepository.findVectorizedFilesMissingEmbeddingModel({
      limit: opts.batchSize,
      afterFileId,
    });
    if (page.length === 0) break;
    afterFileId = page[page.length - 1].id;

    const candidates = await Promise.all(page.map(readEvidence));
    const plan = planFileLabels(candidates, opts.model);

    for (const skip of plan.skipped) {
      const bucket = skipsByReason.get(skip.reason) ?? [];
      bucket.push(`${skip.fabFileId} declared=[${skip.declared.join(', ')}]`);
      skipsByReason.set(skip.reason, bucket);
    }

    // A mistyped --model does not half-work: every file falls to `foreign-chunk-label`, because the
    // model named nothing in the corpus. Catching it on the first page keeps a typo from writing a
    // partial pass that has to be unwound, and only a page that resolved NOTHING can be this - a
    // page with any stamp in it is a real model finding real files.
    const foreign = plan.skipped.filter(s => s.reason === 'foreign-chunk-label');
    if (firstPage && plan.stamp.length === 0 && foreign.length > 0) {
      console.error(
        `\nABORT: no file in the first page of ${page.length} resolves to '${opts.model}', and ` +
          `${foreign.length} declare some other model. Nothing was written.`
      );
      console.error('Declared models seen, one of which is probably the one you meant:');
      for (const m of [...new Set(foreign.flatMap(s => s.declared))].sort()) console.error(`  ${m}`);
      return 2;
    }
    firstPage = false;

    // Before the writes, not after: a crash mid-pass otherwise leaves stamps that cannot be
    // unwound, because nothing recorded which files this pass labeled.
    if (opts.execute && plan.stamp.length > 0) {
      appendFileSync(opts.rollbackLog, rollbackLogLines(plan).join('\n') + '\n');
    }
    rollbackIds.push(...plan.rollbackStampedAtIds);

    const deletedIds = new Set(page.filter(f => f.deleted).map(f => f.id));
    for (const entry of plan.stamp) {
      if (opts.execute) {
        // The same helper the live write path uses, and it re-derives the label itself. This plan is
        // a prediction of that derivation, not an override: if a chunk changed underneath us, the
        // helper writes null and the file simply stays blank for a later run.
        await fabFilesService.stampChunkEmbeddingModel(
          entry.fabFileId,
          entry.label,
          { db: { fabFiles: fabFileRepository, fabFileChunks: fabFileChunkRepository }, logger: console },
          { stampFile: true }
        );
      }
      stamped++;
      if (deletedIds.has(entry.fabFileId)) deletedStamped++;
    }
  }

  console.log(`\n${opts.execute ? 'Stamped' : 'Would stamp'} ${stamped} file(s) -> ${opts.model}.`);
  if (deletedStamped > 0) {
    // Not excluded: the population is defined by vector state alone, and a soft-deleted row can be
    // restored. Reported so the operator's count reconciles with the one they started from.
    console.log(`  (${deletedStamped} of those are soft-deleted rows.)`);
  }
  if (stamped > 0) {
    console.log(
      opts.execute
        ? `  ${stamped} id(s) written to ${opts.rollbackLog}, ${rollbackIds.length} of them needing ` +
            'chunkEmbeddingModelStampedAt cleared as well.'
        : `  dry run: nothing written to ${opts.rollbackLog}; ${rollbackIds.length} of the ${stamped} ` +
            'would need chunkEmbeddingModelStampedAt cleared as well.'
    );
  }

  for (const [reason, files] of [...skipsByReason].sort()) {
    console.warn(`\n${files.length} file(s) SKIPPED as ${reason}:`);
    for (const f of files) console.warn(`  ${f}`);
  }
  if (skipsByReason.has('spans-multiple-spaces')) {
    console.warn('\nspans-multiple-spaces is a deliberate blank label, not a defect: the file holds');
    console.warn('vectors in two spaces and no single value is true of both. Re-embedding consolidates it.');
  }
  if (skipsByReason.has('unattributable-vector-width')) {
    console.warn('\nunattributable-vector-width means this pass has lost its exemption for those files.');
    console.warn('See ATTRIBUTABLE_VECTOR_WIDTH in labelBlankFilesPlan.ts before widening it.');
  }

  // Straight from the collection rather than `before - stamped`: a pass that skipped rows it could
  // not resolve would otherwise be reporting its own arithmetic back as verification.
  const after = await fabFileRepository.countVectorizedFilesMissingEmbeddingModel();
  console.log(`\nStill unlabeled: ${after} (was ${before}).`);
  if (!opts.execute) console.log('Dry run: nothing was written. Re-run with --execute.');

  // Only the skips that mean this pass could not do something it SHOULD have been able to do.
  // `no-vector-bearing-chunks` (a stale rollup counter on a file with no chunks left) and
  // `spans-multiple-spaces` (a deliberately blank label) are standing properties of the corpus:
  // they are reported every run, no run can clear them, and exiting nonzero for them trains the
  // operator to read this script's failure code as noise - which is the one thing that must stay
  // legible when a wrong --model or an expired width exemption does show up.
  const actionable = ([...skipsByReason.keys()] as SkipReason[]).filter(
    r => r === 'foreign-chunk-label' || r === 'unattributable-vector-width'
  );
  return actionable.length > 0 ? 1 : 0;
}

const argv = yargs(hideBin(process.argv))
  .option('execute', { type: 'boolean', default: false, describe: 'Actually write (default: dry-run)' })
  .option('batch-size', { type: 'number', default: 500, describe: 'Files read per page' })
  .option('model', {
    type: 'string',
    demandOption: true,
    describe:
      'The model that vectorized these files (e.g. text-embedding-ada-002). Required, and verified ' +
      "against each file's own chunk labels; a model that matches nothing aborts before writing.",
  })
  .option('rollback-log', {
    type: 'string',
    default: 'label-blank-files-rollback.txt',
    describe: 'Where to record ids that had no prior chunkEmbeddingModelStampedAt, written before the stamps',
  })
  .parseSync();

main({
  execute: argv.execute,
  batchSize: argv['batch-size'],
  model: argv.model,
  rollbackLog: argv['rollback-log'],
})
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
