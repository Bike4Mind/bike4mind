/**
 * The one published `confidence` formula for every decision provider. We never pass a vendor's own value
 * through: both formulas reproduce two vendors' documented examples, so the field stays portable
 * across models. Predicates have no confidence; their probability already says it.
 */

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

/** Choice: `(n * p_max - 1) / (n - 1)`, i.e. 0 for a uniform distribution and 1 for a certain one. */
export const choiceConfidence = (probabilities: readonly number[]): number => {
  const n = probabilities.length;
  if (n < 2) return 1;
  const peak = Math.max(...probabilities);
  return clampUnit((n * peak - 1) / (n - 1));
};

const expectedDistance = (probabilities: readonly number[], from: number): number =>
  probabilities.reduce((sum, p, index) => sum + p * Math.abs(index - from), 0);

/**
 * Score: `1 - sum(p_i * |i - peak|) / mean_i(|i - (n-1)/2|)`. Distance-aware, so mass on a neighbouring level
 * costs less confidence than mass on the far end of the scale. On a tie for the peak we take the level that
 * minimises the expected distance; the clamp covers near-uniform distributions that would otherwise go negative.
 */
export const scoreConfidence = (probabilities: readonly number[]): number => {
  const n = probabilities.length;
  if (n < 2) return 1;
  const max = Math.max(...probabilities);
  const peakCandidates = probabilities.flatMap((p, index) => (p === max ? [index] : []));
  const spread = Math.min(...peakCandidates.map(index => expectedDistance(probabilities, index)));
  const center = (n - 1) / 2;
  const normalizer = probabilities.reduce((sum, _p, index) => sum + Math.abs(index - center), 0) / n;
  return clampUnit(1 - spread / normalizer);
};

/** The probability-weighted mean of 0-based level indices. */
export const weightedScore = (probabilities: readonly number[]): number =>
  probabilities.reduce((sum, p, index) => sum + p * index, 0);
