#!/usr/bin/env tsx
/**
 * Sweep the two forced-retrieval relevance floors over captured embedding fixtures (#2572, item 2).
 *
 * Pure: no database, no provider key, no network, no stage. Everything it needs was already paid
 * for by `capture-embeddings.ts`, so a floor pair costs nothing to try and the whole sweep can be
 * re-run after the embedding migration (#471) re-captures the corpus - which is the point. Both
 * floors ship at behavior-preserving defaults fitted to the ada-002 band, and that band moves on
 * the migration; #2572 item 4 is the re-tune this instrument exists to inform.
 *
 * Paths are resolved from `packages/scripts/`, the cwd `pnpm --filter` runs in and where
 * `capture-embeddings.ts` writes its `out/` by default, so the two halves agree without an absolute
 * path in either.
 *
 *   pnpm --filter @bike4mind/scripts retrieval:forced-floor-sweep \
 *     --fixture out/text-embedding-3-small.system-help.fixture.json \
 *     --floors 0:0,85:75,85:0,90:0,95:0
 *
 * READ THE TABLE IN THIS ORDER. `bound` first: a relative floor with 0.0% there is inert on this
 * corpus, which is the failure the relative floor was introduced to fix in the absolute one and is
 * just as possible for the relative one at the wrong value. Then `cut @` against `budget-bound` - a
 * floor cutting past where the char budget already stopped changes nothing that reaches the model.
 * Only then recall and precision, which are the cost of a floor that does bind.
 *
 * ONE CAVEAT THE WRITE-UP MUST CARRY, inherited from `scoreDistribution.ts`: this is exact kNN over
 * every captured chunk, where prod now serves through Atlas `$vectorSearch` (ANN, #2526). The
 * served pool is a top-K hit set rather than a full scan, so a floor's cut rank measured here is
 * measured over a deeper pool than production gates. The floor arithmetic is shared with the served
 * path and cannot drift from it; the candidate set it runs over is the instrument's own.
 */

import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT, FORCED_RETRIEVAL_MAX_SCORED_CHUNKS } from '@bike4mind/common';
import { loadEmbeddingFixture } from './embeddingFixture';
import { resolveQueries } from './modelComparison';
import {
  buildFloorSweepRow,
  formatFloorSweepTable,
  parseFloorConfigs,
  type FloorScorableChunk,
} from './forcedFloorSweep';

const argv = await yargs(hideBin(process.argv))
  .option('fixture', {
    type: 'string',
    demandOption: true,
    describe: 'A capture fixture path (one model arm - floors are swept within one vector space)',
  })
  .option('floors', {
    type: 'string',
    default: '0:0,85:75',
    describe:
      'Comma-separated "relativeFloorPct:minSimilarityPct" pairs. 0 turns the relative floor off; ' +
      '0 on the absolute floor is a floor AT zero, which still rejects negative cosines',
  })
  .option('char-budget', {
    type: 'number',
    default: FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT,
    describe: 'forcedRetrievalCharBudget to measure the floors against',
  })
  .strict()
  .parse();

if (!Number.isInteger(argv['char-budget']) || argv['char-budget'] < 0) {
  throw new Error(`--char-budget must be a non-negative integer, got "${argv['char-budget']}"`);
}

// `loadEmbeddingFixture` also checks each query's `questionHash`, which matters here: a floor
// measured against a reworded question is measured against ground truth that no longer describes
// it, and the id alone cannot say which text was embedded under it.
const fixture = loadEmbeddingFixture(JSON.parse(readFileSync(argv.fixture, 'utf8')) as unknown);

// Reuses the model comparison's resolver rather than looking the ground truth up here, because it
// makes an id `corpus.ts` does not know an ERROR. Defaulting such an id to an empty supporting set
// would score it as a deliberate NEGATIVE, quietly inflating the false-positive rate and moving
// precision's denominator - a complete, confident, wrong table.
const queries = resolveQueries(fixture);

const chunks: FloorScorableChunk[] = fixture.chunks.map(c => ({
  chunkId: c.chunkId,
  docId: c.docId,
  vector: c.vector,
  charLength: c.charLength,
}));

const rows = parseFloorConfigs(argv.floors).map(config =>
  buildFloorSweepRow({ config, chunks, queries, charBudget: argv['char-budget'] })
);

console.log(
  `${fixture.model}@${fixture.dims} on ${fixture.corpus}: ` +
    `${chunks.length} chunks, ${queries.length} queries, budget ${argv['char-budget']} chars\n`
);
console.log(formatFloorSweepTable(rows));

// Loud rather than a column, because it is a caveat on how to read `cut @` and not a property of
// either floor: past the cap the ranks are ranks within a truncated pool.
const capped = rows.filter(r => r.cappedQueries > 0);
if (capped.length > 0) {
  console.log(
    `
NOTE: the ${FORCED_RETRIEVAL_MAX_SCORED_CHUNKS}-chunk pool cap truncated the candidate set on ` +
      `${Math.max(...capped.map(r => r.cappedQueries))} of ${queries.length} queries. ` +
      'Every "cut @" rank below is a rank within that truncated pool.'
  );
}
