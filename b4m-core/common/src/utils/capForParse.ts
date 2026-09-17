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
 * PREFER LINEARIZING THE PARSER. A cap is the fallback, not the first move. The email
 * cleaners in services/lib/turndown.ts and the snippet-meta extractor in common/utils.ts
 * both started here and both ended up as single-pass scans instead, because a cap that
 * was small enough to bound their cost was also small enough to stop them working on
 * real content. When the parser is linear, the cap can go.
 *
 * SIZING RULE - if you do cap, pick `max` from the parser's measured cost AT the cap,
 * not from the headroom above real input. For an O(n^2)/O(n^3) inner loop, "far above
 * anything legitimate" is not a bound: the email cleaners were cubic, so a 512k cap
 * still ran for minutes. Measure the worst-case shape at the cap you intend to ship and
 * make sure the number of milliseconds is one you can defend.
 *
 * Four further traps this helper cannot solve for you:
 * - A per-item cap is not a total bound when the item count is also attacker-chosen
 *   (a .pptx picks its own slide count). Carry a running budget across the loop.
 * - Cap what is SCANNED, not what is returned. Where the result is rendered or
 *   stored, re-append `input.slice(max)` unchanged: truncating the value silently
 *   drops content, and a cut inside an element can strand its closing tag. Splicing
 *   the original halves back together also avoids leaving a lone surrogate, since
 *   `slice` cuts by UTF-16 code unit.
 * - Splicing the tail back is not enough when the cap changes the SHAPE of the parse
 *   rather than only its length - a pattern terminated by `$`, say, whose sections then
 *   end early and get classified differently. Check what an over-cap input parses INTO,
 *   not just that its characters survive.
 * - Cap in front of a best-effort cleaner or detector, where degrading quietly is
 *   acceptable. Do not cap in front of a parser whose output drives execution (a
 *   tool-call parser): silently parsing a prefix there means running a subset of what
 *   was asked. If such a parser caps internally, its callers must pass it text already
 *   scoped to the construct being parsed.
 *
 * @returns the input unchanged when within budget, otherwise its first `max` chars.
 */
export function capForParse(input: string, max: number = DEFAULT_PARSE_CAP): string {
  // Finite, not just non-negative: NaN fails every comparison, so an unchecked NaN cap
  // makes this return '' and a caller that re-appends the tail scrub nothing at all.
  if (!Number.isFinite(max) || max < 0) {
    throw new RangeError(`capForParse: max must be a non-negative finite number, got ${max}`);
  }
  return input.length <= max ? input : input.slice(0, max);
}
