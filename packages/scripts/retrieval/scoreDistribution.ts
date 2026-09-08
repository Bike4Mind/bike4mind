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

/** Total order on chunk ids. Returns 0 for equal ids, as the shipped `compareRankedChunks` does. */
const byChunkId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
    .sort((a, b) => b.score - a.score || byChunkId(a.chunk.chunkId, b.chunk.chunkId))
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
  /**
   * Files the served path could not have reached, dropped before their chunks were read: archived,
   * soft-deleted, not fully vectorized, or retrieval-excluded. See `isCapturableFile` in capturePlan.
   */
  filesUnreachable: number;
  queries: number;
  band: ScoreBand;
  meanTopScore: number;
  /**
   * Mean rank-1 cosine on the POSITIVE questions and on the NEGATIVE ones.
   *
   * The gap between them is the floor headroom: a similarity floor can only separate answerable
   * from unanswerable questions if negatives score measurably lower. `falsePositiveRate` cannot say
   * this here - it is structurally 1.0 for every arm, because an offline top-k applies no floor and
   * so always returns k chunks however badly they score. These two numbers are what a later
   * re-derivation of the ada-002-era cosine literals actually needs, and they cost nothing to carry.
   */
  positiveTopScore: number;
  negativeTopScore: number;
  /**
   * Per-query rank-1 minus rank-N, in query order. The published prod row lists these individually
   * (0.0294, 0.0172, 0.0139) rather than averaged, and the go signal is stated against them - so
   * they are kept rather than collapsed, and `meanSpread` is the summary rather than the datum.
   */
  spreads: number[];
  meanSpread: number;
  quality: Aggregate;
  /**
   * Whether the committed ground truth actually describes this corpus.
   *
   * `corpus.ts` names help slugs. A capture of any OTHER lake identifies documents by file id, so
   * nothing can match and every quality metric scores 0 - which reads as a catastrophic model
   * failure rather than as "this corpus has no ground truth". The geometry columns remain valid
   * either way (they need no labels), so the row is still worth printing; the quality columns are
   * rendered `n/a` instead of a number nobody should act on.
   */
  groundTruthApplies: boolean;
};

/** Score every probe query in one arm and roll it up into a row. */
export function buildArmRow(args: {
  arm: string;
  chunks: readonly ScorableChunk[];
  filesInScope: number;
  chunksExcluded: number;
  filesExcluded: number;
  filesUnreachable: number;
  queries: readonly { id: string; vector: number[]; supporting: readonly string[] }[];
  depth?: number;
}): ArmRow {
  const supporting = new Set(args.queries.flatMap(q => [...q.supporting]));
  const groundTruthApplies = supporting.size === 0 || args.chunks.some(c => supporting.has(c.docId));
  const distributions = args.queries.map(q =>
    scoreQueryDistribution(q.id, q.vector, args.chunks, args.depth ?? RANK_DEPTH)
  );
  return {
    arm: args.arm,
    filesInScope: args.filesInScope,
    chunksScored: args.chunks.length,
    chunksExcluded: args.chunksExcluded,
    filesExcluded: args.filesExcluded,
    filesUnreachable: args.filesUnreachable,
    queries: distributions.length,
    band: scoreBand(distributions),
    meanTopScore: mean(distributions.map(d => d.topScores[0] ?? 0)),
    positiveTopScore: mean(
      distributions.filter((_, i) => args.queries[i].supporting.length > 0).map(d => d.topScores[0] ?? 0)
    ),
    negativeTopScore: mean(
      distributions.filter((_, i) => args.queries[i].supporting.length === 0).map(d => d.topScores[0] ?? 0)
    ),
    spreads: distributions.map(d => d.spread),
    meanSpread: mean(distributions.map(d => d.spread)),
    quality: aggregate(distributions.map((d, i) => scoreQuestion(d.servedDocIds, new Set(args.queries[i].supporting)))),
    groundTruthApplies,
  };
}

/** How many per-query spreads to print before eliding, so a 30-question run stays one line. */
const SPREAD_SAMPLE = 6;

/**
 * Render one arm in the shape of the published prod probe block, so a reader can set the two
 * side by side without re-deriving anything.
 *
 * `retrieval_unavailable` is the capture's own reachability drop count (`isCapturableFile`), because
 * the capture enumerates the lake with the lifecycle-sweep reader and therefore genuinely sees that
 * class. `superseded` stays `n/a` rather than 0: this harness runs no collapse pass, so a 0 would
 * claim it checked and found none, which is a different and untrue statement.
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
    `retrieval_unavailable: ${row.filesUnreachable} files unreachable by the served path (archived / not fully vectorized / excluded)`,
    `superseded           : n/a (no collapse pass offline)`,
    `r1-r${RANK_DEPTH} spread`.padEnd(21) + `: ${spreads}${elided}`,
    `overall band         : ${row.band.min.toFixed(4)} - ${row.band.max.toFixed(4)} (width ${row.band.width.toFixed(4)})`,
  ].join('\n');
}

const pad = (s: string, w: number) => s.padEnd(w);
const num = (n: number, dp: number) => n.toFixed(dp);
/**
 * A quality cell, or `n/a` when the ground truth does not describe this corpus. See groundTruthApplies.
 *
 * posTop/negTop are gated the same way inline rather than through here: they are partitioned by
 * `supporting.length`, so they are as label-dependent as recall/mrr, but they keep 4dp.
 */
const quality = (row: ArmRow, value: number) => (row.groundTruthApplies ? value.toFixed(3) : 'n/a');

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
    pad('posTop', 8),
    pad('negTop', 8),
    pad('recall', 8),
    pad('prec', 8),
    pad('hit', 8),
    pad('mrr', 8),
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
      pad(r.groundTruthApplies ? num(r.positiveTopScore, 4) : 'n/a', 8),
      pad(r.groundTruthApplies ? num(r.negativeTopScore, 4) : 'n/a', 8),
      pad(quality(r, r.quality.recall), 8),
      pad(quality(r, r.quality.precision), 8),
      pad(quality(r, r.quality.hitRate), 8),
      pad(quality(r, r.quality.mrr), 8),
    ].join('')
  );

  return [header, '-'.repeat(header.length), ...body].join('\n');
}
