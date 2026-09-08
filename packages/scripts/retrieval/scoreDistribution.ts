/**
 * Score-distribution arithmetic for the embedding-model comparison.
 *
 * The FAB/RAG corpus's problem is not that retrieval finds nothing - it is that everything it finds
 * scores the same. Measured on prod under ada-002 the served chunks collapse into a ~0.058-wide
 * cosine band with rank-1 and rank-10 separated by ~0.014, so the retriever returns ten passages it
 * cannot rank. `retrieval/metrics.ts` cannot see that: it scores WHICH documents were served, and a
 * corpus can rank badly while still serving the right set. This module measures the geometry
 * instead - how far apart the scores are - and the two are meant to be read side by side in one
 * table, because a model that widens the band without improving the ranking has bought nothing.
 *
 * Pure and offline. Scoring goes through the SHIPPED `computeCosineSimilarity` rather than a local
 * copy, so the numbers here are the numbers the brute-force scan computes (ChatCompletionFeatures'
 * ranking loop) and a divergence between harness and product is impossible by construction.
 *
 * ONE CAVEAT THE WRITE-UP MUST CARRY: this is exact kNN over every chunk, where prod's published
 * band came through Atlas `$vectorSearch` (ANN). That is deliberate - the subject of the
 * measurement is the embedding space, and ANN recall would be a confound on top of it - but the two
 * instruments are not identical and a band measured here is not literally comparable to one
 * measured through the served path.
 */

import { computeCosineSimilarity } from '@bike4mind/utils';
import { aggregate, scoreQuestion, type Aggregate } from './metrics';

/** How deep the ranking is inspected. 10 because the published prod band is a rank-1..rank-10 spread. */
export const RANK_DEPTH = 10;

/** A chunk to score. `docId` is the retrieval unit metrics.ts counts (a help slug / file id). */
export type ScorableChunk = {
  chunkId: string;
  docId: string;
  vector: number[];
};

export type QueryDistribution = {
  queryId: string;
  /** Cosine of the top chunks, best first, at most RANK_DEPTH of them. */
  topScores: number[];
  /**
   * rank-1 minus rank-N over the scores actually returned. THE number this module exists for: near
   * zero means the ranking carries no information, however good the recall next to it looks.
   */
  spread: number;
  /** Distinct parent documents, best-chunk-first - exactly what `metrics.ts` scores. */
  servedDocIds: string[];
};

/**
 * Score one query against every chunk and keep the top `RANK_DEPTH`.
 *
 * Ties break on `chunkId` so a rank ordering never depends on chunk arrival order, matching the
 * shipped `compareRankedChunks` total order (b4m-core/utils/src/llm/utils.ts).
 */
export function scoreQueryDistribution(
  queryId: string,
  queryVector: number[],
  chunks: readonly ScorableChunk[],
  depth: number = RANK_DEPTH
): QueryDistribution {
  const ranked = chunks
    .map(chunk => ({ chunk, score: computeCosineSimilarity(queryVector, chunk.vector) }))
    .sort((a, b) => b.score - a.score || (a.chunk.chunkId < b.chunk.chunkId ? -1 : 1))
    .slice(0, depth);

  const seen = new Set<string>();
  return {
    queryId,
    topScores: ranked.map(r => r.score),
    spread: ranked.length > 1 ? ranked[0].score - ranked[ranked.length - 1].score : 0,
    // Forward dedupe (keep the best-scoring occurrence), because reciprocalRank reads this order.
    servedDocIds: ranked.map(r => r.chunk.docId).filter(id => (seen.has(id) ? false : (seen.add(id), true))),
  };
}

/** The cosine band the corpus occupies: where the served scores start, end, and how wide that is. */
export type ScoreBand = { min: number; max: number; width: number };

/**
 * The band across every served score of every query - the headline geometry number.
 *
 * Pooled across queries rather than averaged per query, because the published prod figure
 * (0.8272-0.8856) is a corpus-level statement about where this embedding space puts everything.
 * A per-query band would hide the collapse: each query's own ten results can look spread while all
 * of them sit inside the same narrow global slice.
 */
export function scoreBand(distributions: readonly QueryDistribution[]): ScoreBand {
  const all = distributions.flatMap(d => d.topScores);
  if (all.length === 0) return { min: 0, max: 0, width: 0 };
  const min = Math.min(...all);
  const max = Math.max(...all);
  return { min, max, width: max - min };
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * One `model@width` arm's row: the geometry and the retrieval quality, measured on one corpus.
 *
 * Field names track the published prod probe block so an arm reads directly against it - see
 * `formatArmSummary`. `filesInScope` / `chunksScored` / the exclusion counters are carried through
 * from the capture rather than recomputed here, so an arm that silently lost half the corpus cannot
 * read as a clean win on a smaller, easier set.
 */
export type ArmRow = {
  /** `model@dims`, the identity of the vector space - never the model alone (see MEMENTO_EMBEDDING_ID). */
  arm: string;
  filesInScope: number;
  chunksScored: number;
  /**
   * Chunks the capture could not place in this space, by the shipped `ChunkSkipReason` vocabulary
   * (b4m-core/services/src/dataLakeService/embeddingMismatch.ts).
   */
  chunksExcluded: number;
  /** Distinct files dropped wholesale before their chunks were read (their stamp named another model). */
  filesExcluded: number;
  queries: number;
  band: ScoreBand;
  meanTopScore: number;
  /**
   * Per-query rank-1 minus rank-N, in query order. The published prod row lists these individually
   * (0.0294, 0.0172, 0.0139) rather than averaged, and the go signal is stated against them - so
   * they are kept rather than collapsed, and `meanSpread` is the summary rather than the datum.
   */
  spreads: number[];
  meanSpread: number;
  quality: Aggregate;
};

/** Score every probe query in one arm and roll it up into a row. */
export function buildArmRow(args: {
  arm: string;
  chunks: readonly ScorableChunk[];
  filesInScope: number;
  chunksExcluded: number;
  filesExcluded: number;
  queries: readonly { id: string; vector: number[]; supporting: readonly string[] }[];
  depth?: number;
}): ArmRow {
  const distributions = args.queries.map(q =>
    scoreQueryDistribution(q.id, q.vector, args.chunks, args.depth ?? RANK_DEPTH)
  );
  return {
    arm: args.arm,
    filesInScope: args.filesInScope,
    chunksScored: args.chunks.length,
    chunksExcluded: args.chunksExcluded,
    filesExcluded: args.filesExcluded,
    queries: distributions.length,
    band: scoreBand(distributions),
    meanTopScore: mean(distributions.map(d => d.topScores[0] ?? 0)),
    spreads: distributions.map(d => d.spread),
    meanSpread: mean(distributions.map(d => d.spread)),
    quality: aggregate(distributions.map((d, i) => scoreQuestion(d.servedDocIds, new Set(args.queries[i].supporting)))),
  };
}

/** How many per-query spreads to print before eliding, so a 31-question run stays one line. */
const SPREAD_SAMPLE = 6;

/**
 * Render one arm in the shape of the published prod probe block, so a reader can set the two
 * side by side without re-deriving anything.
 *
 * Two counters from that block are deliberately reported as `n/a` rather than as 0. This harness
 * scores exact cosine over a captured fixture, so `retrieval_unavailable` (indexing/paused files)
 * and `superseded` (collapsed_files) cannot arise here at all - printing 0 would claim the harness
 * checked and found none, which is a different and untrue statement.
 */
export function formatArmSummary(row: ArmRow): string {
  const spreads = row.spreads
    .slice(0, SPREAD_SAMPLE)
    .map(s => s.toFixed(4))
    .join(', ');
  const elided = row.spreads.length > SPREAD_SAMPLE ? `, ... (${row.spreads.length} queries)` : '';
  return [
    `arm                  : ${row.arm}`,
    `files_in_scope       : ${row.filesInScope}`,
    `chunks_scored        : ${row.chunksScored}`,
    `embedding_mismatch   : ${row.filesExcluded} excluded files, ${row.chunksExcluded} skipped chunks`,
    `retrieval_unavailable: n/a (offline exact kNN over a captured fixture)`,
    `superseded           : n/a (no collapse pass offline)`,
    `rank-1 to rank-${RANK_DEPTH} spread : ${spreads}${elided}`,
    `overall band         : ${row.band.min.toFixed(4)} - ${row.band.max.toFixed(4)} (width ${row.band.width.toFixed(4)})`,
  ].join('\n');
}

const pad = (s: string, w: number) => s.padEnd(w);
const num = (n: number, dp: number) => n.toFixed(dp);

/**
 * Render the arms as one fixed-width table.
 *
 * Column order puts the geometry first and the quality second on purpose: the geometry is what this
 * comparison is FOR, and the quality columns are the check that a wider band actually bought better
 * retrieval rather than just rescaling the same ordering.
 */
export function formatComparisonTable(rows: readonly ArmRow[]): string {
  const header = [
    pad('arm', 30),
    pad('files', 8),
    pad('chunks', 8),
    pad('skipped', 8),
    pad('band min', 10),
    pad('band max', 10),
    pad('width', 8),
    pad('spread', 8),
    pad('recall', 8),
    pad('prec', 8),
    pad('hit', 8),
    pad('mrr', 8),
    pad('fpr', 8),
  ].join('');

  const body = rows.map(r =>
    [
      pad(r.arm, 30),
      pad(String(r.filesInScope), 8),
      pad(String(r.chunksScored), 8),
      pad(String(r.chunksExcluded), 8),
      pad(num(r.band.min, 4), 10),
      pad(num(r.band.max, 4), 10),
      pad(num(r.band.width, 4), 8),
      pad(num(r.meanSpread, 4), 8),
      pad(num(r.quality.recall, 3), 8),
      pad(num(r.quality.precision, 3), 8),
      pad(num(r.quality.hitRate, 3), 8),
      pad(num(r.quality.mrr, 3), 8),
      pad(num(r.quality.falsePositiveRate, 3), 8),
    ].join('')
  );

  return [header, '-'.repeat(header.length), ...body].join('\n');
}
