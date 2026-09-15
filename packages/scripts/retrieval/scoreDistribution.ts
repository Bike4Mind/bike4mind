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

import { computeCosineSimilarity, COSINE_SEARCH_TOP_K } from '@bike4mind/utils';
import { aggregate, scoreQuestion, type Aggregate } from './metrics';

/**
 * How deep the ranking is inspected: a shipped retrieval depth rather than a literal, and the 10 the
 * published prod band is a rank-1..rank-10 spread over.
 *
 * BE PRECISE ABOUT WHICH DEPTH IT IS. `COSINE_SEARCH_TOP_K`'s only production use is
 * `similaritySelectChunks` - top-k within ONE attached file - and the lake path this instrument
 * measures derives its own depth in `knowledgeBaseSearch`. Both are 10 today, so the number is right,
 * but the coupling is to a neighbouring knob and not to the one the harness mirrors: a change to
 * either constant alone would move exactly one of them. Taking the shipped value still beats a
 * private literal (it is a value someone maintains, and it is greppable from both sides); it just
 * does not make divergence impossible the way routing every score through the shipped cosine does.
 */
export const RANK_DEPTH = COSINE_SEARCH_TOP_K;

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
   * The same band over the POSITIVE questions only.
   *
   * The pooled `band` above includes the deliberate negatives; the published prod figure this block
   * is shaped to sit beside (0.8272-0.8856, width 0.058) was measured over its three RELEVANT
   * queries. Pooling a negative's top score into a min or a max is exactly the kind of difference an
   * extreme carries, so the instrument check needs the comparable population printed next to the
   * corpus-level one. Label-dependent, like posTop/negTop: meaningless when the ground truth does not
   * describe the corpus, and rendered `n/a` there.
   */
  positiveBand: ScoreBand;
  /**
   * Deliberate negatives in the question set (`supporting: []`), so the pooled band can say what it
   * pooled. The prod figure had none.
   */
  negativeQueries: number;
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
  /**
   * How much of the ground truth this corpus actually holds: supporting documents present, over the
   * total the committed questions name.
   *
   * `groundTruthApplies` is all-or-nothing, so a lake sharing 1 of 49 help slugs passes it and then
   * renders `recall 0.02` as a number - which is the reading that flag exists to prevent. PARTIAL
   * overlap is the likelier accident than zero overlap, and this is what lets the report say so.
   */
  groundTruthCoverage: { matched: number; total: number };
  /**
   * How deep the ranking actually went: the DEEPEST query's returned count, i.e. `max` over the
   * queries of `min(RANK_DEPTH, chunks scored)`. Carried so the spread label states a depth that was
   * inspected rather than the depth that was asked for - on a lake smaller than RANK_DEPTH they
   * differ. `max` and not `min` on purpose: the label claims "we looked this deep somewhere", which
   * is the true statement when queries see different chunk counts.
   */
  rankDepth: number;
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
  const capturedDocs = new Set(args.chunks.map(c => c.docId));
  const matched = [...supporting].filter(docId => capturedDocs.has(docId)).length;
  const groundTruthApplies = supporting.size === 0 || matched > 0;
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
    positiveBand: scoreBand(distributions.filter((_, i) => args.queries[i].supporting.length > 0)),
    negativeQueries: args.queries.filter(q => q.supporting.length === 0).length,
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
    groundTruthCoverage: { matched, total: supporting.size },
    rankDepth: Math.max(0, ...distributions.map(d => d.topScores.length)),
  };
}

/** A band, or `n/a` when it is partitioned by labels the corpus does not carry. See groundTruthApplies. */
const band = (row: ArmRow, b: ScoreBand) =>
  row.groundTruthApplies ? `${b.min.toFixed(4)} - ${b.max.toFixed(4)} (width ${b.width.toFixed(4)})` : 'n/a';

/** How many per-query spreads to print before eliding, so a 30-question run stays one line. */
const SPREAD_SAMPLE = 6;

/**
 * Render one arm in the shape of the published prod probe block, so a reader can set the two
 * side by side without re-deriving anything.
 *
 * TWO bands, not one. `overall band` is pooled across every query including the deliberate
 * negatives - the corpus-level statement. `positives-only band` is the same statistic over the
 * relevant queries alone, which is the population the published prod figure was measured over, so
 * the instrument check compares like with like instead of silently differing by the negatives.
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
    `r1-r${row.rankDepth} spread`.padEnd(21) + `: ${spreads}${elided}`,
    `overall band         : ${row.band.min.toFixed(4)} - ${row.band.max.toFixed(4)} (width ${row.band.width.toFixed(4)})` +
      ` over all ${row.queries} queries${row.negativeQueries > 0 ? `, ${row.negativeQueries} of them negatives` : ''}`,
    `positives-only band  : ${band(row, row.positiveBand)}` +
      ' <- the population the published prod band was measured over',
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
