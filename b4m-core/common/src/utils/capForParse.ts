/**
 * Default character budget for a super-linear parse pass. A starting point only -
 * see the sizing rule below; any call site in front of a measured parser should pass
 * an explicit `max` derived from that parser's own curve.
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
 * not crash the pipeline.
 *
 * SIZING RULE - pick `max` from the parser's measured cost AT the cap, not from the
 * headroom above real input. For an O(n^2)/O(n^3) inner loop, "far above anything
 * legitimate" is not a bound: the email cleaners were cubic, so a 512k cap still ran
 * for minutes, and it only became a bound once the regexes were linearized and the
 * cap re-derived from the new curve. Measure the worst-case shape at the cap you
 * intend to ship and make sure the number of milliseconds is one you can defend.
 *
 * Two further traps this helper cannot solve for you:
 * - A per-item cap is not a total bound when the item count is also attacker-chosen
 *   (a .pptx picks its own slide count). Carry a running budget across the loop.
 * - Cap what is SCANNED, not what is returned. Where the result is rendered or
 *   stored, re-append `input.slice(max)` unchanged: truncating the value silently
 *   drops content, and a cut inside an element can strand its closing tag. Splicing
 *   the original halves back together also avoids leaving a lone surrogate, since
 *   `slice` cuts by UTF-16 code unit.
 *
 * @returns the input unchanged when within budget, otherwise its first `max` chars.
 */
export function capForParse(input: string, max: number = DEFAULT_PARSE_CAP): string {
  if (max < 0) {
    throw new RangeError(`capForParse: max must be non-negative, got ${max}`);
  }
  return input.length <= max ? input : input.slice(0, max);
}
