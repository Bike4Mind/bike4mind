#!/usr/bin/env tsx
/**
 * Sweep the three forced-retrieval relevance floors over captured embedding fixtures (#2572, item 2).
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
 *     --fixture out/text-embedding-3-small.system-help.fixture.ndjson \
 *     --floors 0:0,85:75,85:0,90:0,95:0
 *
 * A third component sweeps the SPREAD floor - `85:75:40` is the shipped pair plus a 40% spread
 * floor - and omitting it leaves that floor off, which is its shipped default.
 *
 * READ THE TABLE IN THIS ORDER. `bound` and `spread-bound` first: a floor with 0.0% there is inert
 * on this corpus, which is the failure the relative floor was introduced to fix in the absolute one
 * and is just as possible for either of the per-turn floors at the wrong value. Then `cut @` and
 * `spread cut @` against `budget-bound` - a floor cutting past where the char budget already
 * stopped changes nothing that reaches the model.
 * Only then recall and precision, which are the cost of a floor that does bind - and read those
 * against `accepted/q` vs `served/q`, because they score the accepted set and only `served/q`
 * reached the model. At a floor low enough to leave hundreds accepted on a corpus of short chunks
 * the two differ by an order of magnitude, and the baseline row's flattering recall is mostly
 * chunks no turn ever saw.
 *
 * `sd` answers a different question from all of them and is the reason the spread floor exists: it
 * is the standard deviation of the accepted count ACROSS queries, so it says whether retrieval
 * volume responds to the question or is a constant the char budget picked. A row can have good
 * recall, good precision and `sd` at 0.0, and that row is a fixed-size dump that happens to be
 * sized well on average.
 *
 * ONE CAVEAT THE WRITE-UP MUST CARRY: this is a full scan over every captured chunk, and the served
 * forced path is not. The divergence is NOT ANN vs exact kNN - forced retrieval never touches Atlas
 * `$vectorSearch` at all, it keyset-pages `findVectorsByFabFileIds` and scores in JS. That caveat
 * belongs to `scoreDistribution.ts`, which measures the knowledge-tool path, and carrying it here
 * contradicts the separation this harness exists to make.
 *
 * The real divergence is three narrowings the served path applies and this harness does not model:
 * the candidate list is capped at FORCED_RETRIEVAL_MAX_CANDIDATE_FILES (100) ordered `fileName`
 * ASC, so past the cap prod scores the alphabetically-first files rather than the most relevant;
 * the scan stops at FORCED_RETRIEVAL_MAX_SCANNED_CHUNKS (4000) per turn; and superseded generations
 * are dropped before scoring. So the served candidate set is not deeper or shallower than this one,
 * it is differently composed - a floor fitted here is fitted to a pool prod may never assemble.
 * None of the three binds on the 51-article `system-help` capture; all three bind on a production lake.
 * The floor arithmetic is shared with the served path and cannot drift from it; the candidate set
 * it runs over is the instrument's own.
 */

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT, FORCED_RETRIEVAL_MAX_SCORED_CHUNKS } from '@bike4mind/common';
import { readEmbeddingFixtureFile } from './embeddingFixture';
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
      'Comma-separated "relativeFloorPct:minSimilarityPct[:spreadFloorPct]" points. 0 turns the ' +
      'relative and spread floors off, and omitting the third component means 0; 0 on the absolute ' +
      'floor is a floor AT zero, which still rejects negative cosines',
  })
  .option('char-budget', {
    type: 'number',
    default: FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT,
    describe: 'forcedRetrievalCharBudget to measure the floors against',
  })
  .strict()
  .parse();

// Rejects 0, not just negatives: the served resolver's `positiveIntOr` can only yield >= 1, and at
// 0 the budget walk below records one chunk served where the served walk breaks at the loop top and
// emits nothing.
if (!Number.isInteger(argv['char-budget']) || argv['char-budget'] < 1) {
  throw new Error(`--char-budget must be a positive integer, got "${argv['char-budget']}"`);
}

// `loadEmbeddingFixture` also checks each COMMITTED query's `questionHash`, which matters here: a
// floor measured against a reworded question is measured against ground truth that no longer
// describes it, and the id alone cannot say which text was embedded under it. An external capture
// (`--questions`) is exempt - it carries its own ground truth, written in the same pass as the text,
// so the two cannot drift apart the way an id join can.
const fixture = readEmbeddingFixtureFile(argv.fixture);

// Reuses the model comparison's resolver rather than looking the ground truth up here, because it
// makes an id neither source knows an ERROR. Defaulting such an id to an empty supporting set
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
