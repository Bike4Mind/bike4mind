#!/usr/bin/env tsx
/**
 * Draw a corpus-wide chunk sample and write the worksheet the positives are authored from.
 *
 * PHASE D of the floor harness, and the half the negatives sweep cannot do. Phase B reports how much
 * a floor serves a question the corpus should not answer; phase C reads that text back and screens
 * it. Both look only at negatives, so together they can say a floor is too LOW and can never say
 * what is right - at the floor where the last negative is refused, `served/q` is 0.0 and legitimate
 * retrieval is destroyed too. Positives are what bound the other side, and a positive is only worth
 * measuring if its supporting set is exact, which means authoring the question from a passage rather
 * than guessing which passages answer a question.
 *
 * WHERE THE SAMPLE COMES FROM, and why not the screen's document. The chunks phase C already read
 * back are the ones that scored top against 89 arbitrary questions; authoring from them and then
 * measuring recall over them flatters the floor by construction. The population here is the whole
 * captured corpus, the draw is blind to score, and `--exclude-served` holds the screened chunks out.
 * See `corpusChunkSample.ts` for the stratification and the determinism.
 *
 * The fixture is the population rather than a fresh corpus read on purpose: it is the exact snapshot
 * the floors were measured over, so every sampled chunk is guaranteed to carry a vector in the
 * fixture that will later score the authored question. It is also the expensive part of this run -
 * a production capture is hundreds of MB and is parsed whole, vectors included.
 *
 * READ-ONLY, and one narrow read: `findTextsByChunkIds` on the sampled ids alone, never the files
 * around them. The caveat in `capture-embeddings.ts` about `connectDB` itself not being write-free
 * applies here unchanged.
 *
 *   npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/sample-corpus-chunks.ts \
 *     --fixture out/<model>.<lake>.fixture.ndjson --count 40 --seed positives-v1 \
 *     --exclude-served out/served.<lake>.json --out out/positives-worksheet.<lake>.md
 *
 * The output holds corpus text. It goes to a file rather than stdout so a lake's contents do not land
 * in a terminal transcript, and `out/` is gitignored.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository } from '@bike4mind/database';
import { readEmbeddingFixtureFile } from './embeddingFixture';
import { formatChunkSampleDoc, selectChunkSample } from './corpusChunkSample';
import { loadServedEmission } from './servedTextScreen';

/** Chunk ids per `$in`. Bounded for the same reason the capture batches its file ids. */
const CHUNK_ID_BATCH = 200;

const argv = await yargs(hideBin(process.argv))
  .option('fixture', {
    type: 'string',
    demandOption: true,
    describe: 'The capture fixture to sample from - the same snapshot the floors were measured over',
  })
  .option('count', { type: 'number', default: 40, describe: 'How many chunks to sample' })
  .option('seed', {
    type: 'string',
    demandOption: true,
    describe:
      'Any string, recorded in the output. Required rather than defaulted so the draw is a stated ' +
      'parameter of the measurement; the same seed re-draws the same sample, a different one is independent',
  })
  .option('exclude-served', {
    type: 'string',
    describe:
      'A `--emit-served` emission whose chunks are held out - the text a screen already used as ' +
      'negatives evidence, which is the corpus text most likely to be generically attractive',
  })
  .option('min-chars', {
    type: 'number',
    default: 0,
    describe:
      'Drop chunks shorter than this. Default 0: a length filter narrows the corpus the floor is ' +
      'then measured over, so any value here is a deliberate narrowing',
  })
  .option('max-chars', { type: 'number', default: 4000, describe: 'Truncate each passage at this many characters' })
  .option('id-prefix', { type: 'string', default: 'p', describe: 'Question id prefix in the worksheet' })
  .option('out', { type: 'string', demandOption: true, describe: 'Markdown path to write the worksheet to' })
  .strict()
  .parse();

for (const flag of ['count', 'max-chars'] as const) {
  if (!Number.isInteger(argv[flag]) || argv[flag] < 1) {
    throw new Error(`--${flag} must be a positive integer, got "${argv[flag]}"`);
  }
}
if (!Number.isInteger(argv['min-chars']) || argv['min-chars'] < 0) {
  throw new Error(`--min-chars must be a non-negative integer, got "${argv['min-chars']}"`);
}

// Everything local is read and validated before the DB connection: a typo in either path should fail
// on the file rather than after a read against a production stage.
const fixture = readEmbeddingFixtureFile(argv.fixture);

let holdout: string[] = [];
if (argv['exclude-served'] !== undefined) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(argv['exclude-served'], 'utf8'));
  } catch (error) {
    throw new Error(
      `Served-ids file "${argv['exclude-served']}" could not be read as JSON: ${(error as Error).message}`
    );
  }
  const emission = loadServedEmission(raw, argv['exclude-served']);
  if (emission.corpus !== fixture.corpus) {
    throw new Error(
      `Holdout file is for corpus "${emission.corpus}" and the fixture is "${fixture.corpus}". Holding ` +
        "out another lake's chunk ids would silently hold nothing out at all."
    );
  }
  // The UNION across floor points, not one point's set: a chunk any floor served is a chunk the
  // screen's evidence touched, and the low floors serve the most.
  holdout = [...new Set(emission.floors.flatMap(f => f.distinctServedChunkIds))];
} else {
  console.log(
    'NOTE: no --exclude-served, so nothing is held out. If a screen has already been done on this ' +
      'corpus, its served chunks are in this population and the recall measured over the result will ' +
      'be biased upward.'
  );
}

const sample = selectChunkSample({
  chunks: fixture.chunks,
  count: argv.count,
  seed: argv.seed,
  excludeChunkIds: holdout,
  minChars: argv['min-chars'],
});
// Loud rather than a line in the output: a caller reading `picked.length` as the count it asked for
// would report a sample it never drew.
if (sample.shortfall > 0) {
  console.log(
    `WARNING: asked for ${argv.count} chunks and the eligible corpus yielded ${sample.picked.length}. ` +
      'The holdout or --min-chars may be taking more than intended.'
  );
}

await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
console.log(`Connected (stage: ${Resource.App.stage})`);

const texts = new Map<string, string>();
const sampledIds = sample.picked.map(c => c.chunkId);
for (let i = 0; i < sampledIds.length; i += CHUNK_ID_BATCH) {
  for (const row of await fabFileChunkRepository.findTextsByChunkIds(sampledIds.slice(i, i + CHUNK_ID_BATCH))) {
    texts.set(row.id, row.text);
  }
}

mkdirSync(path.dirname(path.resolve(argv.out)), { recursive: true });
writeFileSync(
  argv.out,
  formatChunkSampleDoc({
    sample,
    model: fixture.model,
    dims: fixture.dims,
    corpus: fixture.corpus,
    texts,
    count: argv.count,
    minChars: argv['min-chars'],
    maxChars: argv['max-chars'],
    idPrefix: argv['id-prefix'],
  })
);

// Counts only - the text itself stays in the file.
console.log(
  `Sampled ${sample.picked.length} chunks from ${sample.filesSampled} of ${sample.filesInCorpus} files ` +
    `in ${fixture.corpus} (${fixture.chunks.length} chunks, seed "${argv.seed}"); ` +
    `held out ${sample.excludedByHoldout}, below --min-chars ${sample.excludedByMinChars}; ` +
    `${texts.size} of ${sampledIds.length} read back. Wrote ${argv.out}`
);
process.exit(0);
