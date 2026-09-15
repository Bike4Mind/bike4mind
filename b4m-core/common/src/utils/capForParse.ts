/**
 * Default character budget for a super-linear parse pass. Chosen well above any
 * legitimate single-artifact size so real content is never truncated, while still
 * bounding the cost of adversarial input crafted to trigger quadratic (or worse)
 * regex backtracking. Callers with a tighter or looser legitimate maximum pass an
 * explicit `max`.
 */
export const DEFAULT_PARSE_CAP = 100_000;

/**
 * Bound the length of input a super-linear parser will scan.
 *
 * A regex that backtracks polynomially (or worse) turns an unbounded input length
 * into unbounded CPU on a shared process - the algorithmic-DoS shape. Refusing to
 * scan more than `max` characters converts that into a fixed worst case regardless
 * of how pathological the input is.
 *
 * Truncation (never throwing) is deliberate: these caps sit in front of best-effort
 * cleaners and content detectors where an over-cap input should degrade quietly,
 * not crash the pipeline. Set `max` generously per site - above any legitimate
 * input - so only adversarial or absurd inputs are ever shortened.
 *
 * @returns the input unchanged when within budget, otherwise its first `max` chars.
 */
export function capForParse(input: string, max: number = DEFAULT_PARSE_CAP): string {
  if (max < 0) {
    throw new RangeError(`capForParse: max must be non-negative, got ${max}`);
  }
  return input.length <= max ? input : input.slice(0, max);
}
