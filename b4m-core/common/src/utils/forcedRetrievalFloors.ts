/**
 * The arithmetic of the three forced-retrieval relevance floors, shared by the served path
 * (`ChatCompletionFeatures.ts`, `KnowledgeRetrievalFeature`) and the offline sweep that exists to
 * pick their values (`packages/scripts/retrieval/forcedFloorSweep.ts`).
 *
 * It lives here for the same reason `retrieval/scoreDistribution.ts` routes its scoring through the
 * shipped `computeCosineSimilarity` rather than a local copy: a harness that reimplements the gate
 * it is measuring can drift from it, and a sweep fitted to a drifted gate recommends a value for a
 * filter that does not exist. Both callers multiplying the same way makes that impossible by
 * construction, which a cross-reference comment cannot promise.
 *
 * UNITS. Every number here is a 0..1 cosine fraction. The three admin settings store whole-number
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

/**
 * The turn's BACKGROUND score: what a chunk of this corpus typically scores against this query.
 *
 * The median rather than the mean or the minimum, because this is the reference the spread floor
 * measures against and it has to survive the shape of a real scan. A mean is dragged by the same
 * cluster of near-top hits the floor is trying to separate out, and a minimum is set by whichever
 * single worst chunk the scan happened to reach - on a partial scan that is not even a stable
 * quantity between two identical turns.
 *
 * `scores` is every FINITE score compared this turn, not the pool that cleared the absolute floor.
 * Gating the population first would make the background a function of the floor it is meant to be
 * independent of, and on a corpus where the absolute floor already admits everything (the case this
 * mechanism exists for) the two would coincide and hide the bug.
 *
 * Sorts a copy: the served path's caller keeps its scores in scan order for other diagnostics.
 * Returns `undefined` for an empty input rather than a sentinel, so a caller with nothing scored
 * has to decide what that means instead of inheriting a number that reads like a measurement.
 */
export function backgroundScoreOf(scores: readonly number[]): number | undefined {
  if (scores.length === 0) return undefined;
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The absolute score a candidate must reach to clear the spread floor, or 0 when the floor is off.
 *
 * `topScore - spreadFloor * (topScore - backgroundScore)`: a point a given fraction of the way down
 * from this turn's best score toward a typical one. See `FORCED_RETRIEVAL_SPREAD_FLOOR_PCT_DEFAULT`
 * for why the span rather than either endpoint is the unit.
 *
 * Returns 0 - the "no cut" value both other floor helpers use - in three cases, each of which is a
 * turn where the span carries no information rather than a turn that should be gated hard:
 *   - the floor is off (`spreadFloor <= 0`),
 *   - `backgroundScore` is absent, i.e. nothing was scored,
 *   - the span is not positive, i.e. the top score does not exceed the background. That happens
 *     when every chunk scores identically (a one-chunk corpus reaches it), and the cutoff would
 *     otherwise land exactly ON the top score and keep only the chunks tied with it - a hard cut
 *     justified by no measured spread at all.
 *
 * Unlike `forcedRetrievalRelativeCutoff` this needs no guard against a negative `topScore`: the
 * result is an interpolation between two scores that both came from the pool, so it lies between
 * them and can never sit above the best candidate. That bound holds for any `spreadFloor >= 0`,
 * which is what makes the gate unable to empty a turn.
 */
export function forcedRetrievalSpreadCutoff(
  topScore: number,
  backgroundScore: number | undefined,
  spreadFloor: number
): number {
  if (spreadFloor <= 0 || backgroundScore === undefined) return 0;
  const span = topScore - backgroundScore;
  if (span <= 0) return 0;
  return topScore - spreadFloor * span;
}
