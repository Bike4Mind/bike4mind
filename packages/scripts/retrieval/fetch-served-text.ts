#!/usr/bin/env tsx
/**
 * Read back the TEXT of the chunks a floor served, and write the screening document.
 *
 * PHASE C of the floor harness. `capture-embeddings.ts` pays for the corpus (phase A) and
 * `forced-floor-sweep.ts` measures floors over it offline (phase B), but neither can answer the
 * question a floor result raises next: the sweep reports that a negative question was served six
 * chunks, and whether that is a false positive depends on whether those six answer it. A fixture
 * carries no chunk text, so this is the one read that closes it.
 *
 * READ-ONLY, and as narrow as the question allows: `findTextsByChunkIds` is keyed on chunk id, so
 * this fetches exactly the chunks a floor served and never the files around them. The caveat in
 * `capture-embeddings.ts` about `connectDB` itself not being write-free applies here unchanged.
 *
 *   npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/fetch-served-text.ts \
 *     --served out/served.json --questions <path> --out out/screen.md
 *
 * The output holds corpus text. It is written to a file rather than stdout so a lake's contents do
 * not land in a terminal transcript, and `out/` is gitignored.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import { connectDB, fabFileChunkRepository } from '@bike4mind/database';
import { parseProbeQuestions, PROBE_QUESTIONS } from './corpus';
import { formatServedScreen, loadServedEmission, selectServedFloor, type ServedChunkText } from './servedTextScreen';

/** Chunk ids per `$in`. Bounded for the same reason the capture batches its file ids. */
const CHUNK_ID_BATCH = 200;

const argv = await yargs(hideBin(process.argv))
  .option('served', {
    type: 'string',
    demandOption: true,
    describe: 'The JSON written by `forced-floor-sweep.ts --emit-served`',
  })
  .option('floor', {
    type: 'string',
    describe:
      'Which floor point to screen, matched as a substring of its label (e.g. "absolute=49%"). ' +
      'Only optional when the emission holds a single point',
  })
  .option('questions', {
    type: 'string',
    describe:
      'The question file the capture was given. Omit to use the committed PROBE_QUESTIONS, the ' +
      'same default `capture-embeddings.ts` applies - anything but system-help needs the file',
  })
  .option('out', { type: 'string', demandOption: true, describe: 'Markdown path to write the screen to' })
  .option('max-chars', {
    type: 'number',
    default: 1500,
    describe: 'Truncate each chunk at this many characters in the output',
  })
  .strict()
  .parse();

if (!Number.isInteger(argv['max-chars']) || argv['max-chars'] < 1) {
  throw new Error(`--max-chars must be a positive integer, got "${argv['max-chars']}"`);
}

// Both files are parsed before the DB connection: a typo in either should fail on the file rather
// than after a read against a production stage.
const readJson = (file: string, label: string): unknown => {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label} "${file}" could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} "${file}" could not be read as JSON: ${(error as Error).message}`);
  }
};

const emission = loadServedEmission(readJson(argv.served, 'Served-ids file'), argv.served);
const floor = selectServedFloor(emission, argv.floor);
const probeQuestions = argv.questions
  ? parseProbeQuestions(readJson(argv.questions, 'Question file'), argv.questions)
  : PROBE_QUESTIONS;
const questionSource = argv.questions ?? 'the committed PROBE_QUESTIONS';
const questions = new Map(probeQuestions.map(q => [q.id, q.question]));

// Named rather than silently tolerated: the screen would still render, with every question's text
// reading "(not in the questions file)", which looks like a formatting problem and is actually the
// wrong question file.
const unknownIds = floor.queries.filter(q => !questions.has(q.id)).map(q => q.id);
if (unknownIds.length === floor.queries.length) {
  throw new Error(
    `None of the ${floor.queries.length} question ids in "${argv.served}" appear in ${questionSource} - ` +
      'this is a different question set than the capture used.'
  );
}
if (unknownIds.length > 0) {
  console.log(`WARNING: ${unknownIds.length} question id(s) absent from the question file: ${unknownIds.join(', ')}`);
}

await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
console.log(`Connected (stage: ${Resource.App.stage})`);

const texts = new Map<string, ServedChunkText>();
for (let i = 0; i < floor.distinctServedChunkIds.length; i += CHUNK_ID_BATCH) {
  const batch = floor.distinctServedChunkIds.slice(i, i + CHUNK_ID_BATCH);
  for (const row of await fabFileChunkRepository.findTextsByChunkIds(batch)) texts.set(row.id, row);
}

mkdirSync(path.dirname(path.resolve(argv.out)), { recursive: true });
writeFileSync(argv.out, formatServedScreen({ emission, floor, texts, questions, maxChars: argv['max-chars'] }));

// Counts only - the text itself stays in the file.
console.log(
  `Screened floor "${floor.floor}": ${floor.queries.length} questions, ` +
    `${texts.size} of ${floor.distinctServedChunkIds.length} served chunks read. Wrote ${argv.out}`
);
process.exit(0);
