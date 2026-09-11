/**
 * The arithmetic of the two forced-retrieval relevance floors, shared by the served path
 * (`ChatCompletionFeatures.ts`, `KnowledgeRetrievalFeature`) and the offline sweep that exists to
 * pick their values (`packages/scripts/retrieval/forcedFloorSweep.ts`).
 *
 * It lives here for the same reason `retrieval/scoreDistribution.ts` routes its scoring through the
 * shipped `computeCosineSimilarity` rather than a local copy: a harness that reimplements the gate
 * it is measuring can drift from it, and a sweep fitted to a drifted gate recommends a value for a
 * filter that does not exist. Both callers multiplying the same way makes that impossible by
 * construction, which a cross-reference comment cannot promise.
 *
 * UNITS. Every number here is a 0..1 cosine fraction. The two admin settings store whole-number
 * percents, and `ChatCompletionFeatures`' `forcedRetrievalFloorFraction` divides by 100 exactly
 * once before anything reaches this module - see `FORCED_RETRIEVAL_MIN_SIMILARITY_PCT_DEFAULT` for
 * why the stored unit is a percent. A caller passing 85 where 0.85 belongs gets a cutoff above every
 * possible cosine and an empty result, so the fraction contract is stated rather than inferred.
 */

/**
 * The absolute score a candidate must reach to clear the relative floor, or 0 when the floor is off.
 *
 * `topScore` is the turn's best score across the WHOLE scanned pool - every reachable lake, one
 * pool, one top score - not a per-lake or per-file maximum. A per-lake rung would need per-lake
 * top-score semantics defined first (see issue #2572, item 3).
 *
 * The `topScore > 0` guard is what makes this safe to share rather than inline. A multiplicative
 * floor inverts across zero (0.85 * -0.2 = -0.17, ABOVE the score it came from), so on a negative
 * top score the cutoff would sit above every candidate and empty the turn. The served path cannot
 * reach that today because its absolute floor is positive, but the sweep can: it is handed arbitrary
 * floor pairs by an operator, including `minSimilarity` 0 over a corpus with negative cosines.
 */
export function forcedRetrievalRelativeCutoff(topScore: number, relativeFloor: number): number {
  return relativeFloor > 0 && topScore > 0 ? topScore * relativeFloor : 0;
}

/** The ranking identity of a scored chunk: enough to reproduce the served path's total order. */
export type ForcedRetrievalRankable = {
  score: number;
  /** The parent file. `fabFileId` on the served path, `docId` in the offline fixtures. */
  fileId: string;
  chunkId: string;
};

/**
 * Total order: score desc, then fileId, then chunkId.
 *
 * The explicit tiebreaker is load-bearing on both sides. On the served path chunks arrive in
 * batches, so equal scores would otherwise be ordered by fetch order and the citation numbering
 * could differ between two identical turns. In the sweep the same ties decide which candidates
 * survive the `FORCED_RETRIEVAL_MAX_SCORED_CHUNKS` cap, and therefore what a floor is measured
 * against - so a harness with its own tiebreak could report a cut the served path would not make.
 */
export function compareForcedRetrievalRank(a: ForcedRetrievalRankable, b: ForcedRetrievalRankable): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.fileId !== b.fileId) return a.fileId < b.fileId ? -1 : 1;
  return a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0;
}
