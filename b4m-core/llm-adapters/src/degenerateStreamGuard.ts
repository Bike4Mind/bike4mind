/**
 * Degeneration circuit breaker for a streaming completion.
 *
 * Guards against the non-terminating GENERATION loop, where a model stops making
 * progress and emits the same short unit over and over until it exhausts the
 * output-token ceiling. Observed in the wild: a turn that fell into repeating
 * tool-call closing markup (`</invoke>` 6,099 times, `</parameter>` 6,017 times)
 * and ran for 16.5 minutes to consume all 128,000 permitted output tokens,
 * producing ~180KB of which ~95% was those two tags.
 *
 * This is the token-stream analogue of repeatedCallGuard (which covers repeated
 * TOOL CALLS in the ReAct loop). Neither one catches the other's failure mode.
 * The idle-timeout guard in the backends does not catch this either: it resets on
 * every stream event, and a repetition loop emits events continuously, so it stays
 * alive indefinitely. Before this guard the token ceiling was the only stop
 * condition, which makes it a ~16-minute, multi-dollar stop condition.
 *
 * Detection is periodicity of the stream TAIL, not a blocklist of known-bad
 * strings: a model can degenerate into any repeating unit, and the pathology is
 * the repetition itself.
 *
 * Cost: one `lastIndexOf` over a bounded window per check, and checks run only
 * every `checkEveryChars`. That is O(window) amortized per emitted chunk with no
 * per-period scan, so it is safe to leave on for every stream.
 */

/** How the tail is sampled and what counts as degenerate. */
export interface DegenerateStreamGuardOptions {
  /** Set false to disable the guard entirely. Default: true (active). */
  enabled?: boolean;
  /**
   * Chars of trailing output kept for analysis. Must exceed `minRunChars` with
   * room to spare, or a long run can never be measured.
   */
  windowChars?: number;
  /** Re-check after this much new text. Bounds CPU on healthy streams. */
  checkEveryChars?: number;
  /**
   * Longest repeating unit considered. A degenerate loop cycles on something
   * small (a tag, a line, a short phrase); a "repeat" longer than this is far
   * more likely to be legitimate structure (boilerplate blocks, tables).
   */
  maxPeriodChars?: number;
  /** Minimum length of the periodic run before it counts as degenerate. */
  minRunChars?: number;
  /** Minimum number of consecutive repetitions of the unit. */
  minRepeats?: number;
}

export interface DegenerateStreamVerdict {
  /** The repeating unit, for logs. Truncated - it can contain newlines. */
  unit: string;
  /** Length of the repeating unit in chars. */
  periodChars: number;
  /** How many consecutive repetitions were measured. */
  repeats: number;
  /** Length in chars of the periodic run at the tail. */
  runChars: number;
  /** Total chars the guard has seen, i.e. roughly where the loop was caught. */
  totalChars: number;
}

/**
 * Defaults are deliberately conservative: tripping requires a run of >= 2048
 * chars that is periodic on a unit of <= 512 chars repeated >= 25 times. Prose,
 * code, JSON, and base64 do not do that; a degenerate loop does it within a
 * second or two of starting. The asymmetry is intentional - a false positive
 * truncates one reply with an explicit reason, while a miss costs the full
 * ceiling in latency and spend.
 */
const DEFAULTS = {
  enabled: true,
  windowChars: 8192,
  checkEveryChars: 512,
  maxPeriodChars: 512,
  minRunChars: 2048,
  minRepeats: 25,
} as const;

/**
 * Chars used as the search needle. Long enough that finding an earlier copy is
 * not coincidence, short enough to sit inside one repetition of a small unit
 * (the observed `</invoke>\n</parameter>\n` unit is 23 chars).
 */
const NEEDLE_CHARS = 16;

/** Unit length included in a verdict, so a log line stays readable. */
const UNIT_LOG_LIMIT = 120;

export interface DegenerateStreamGuard {
  /**
   * Feed newly emitted text. Returns a verdict the first time degeneration is
   * detected, then null forever after (the caller aborts on the first verdict;
   * latching prevents a second abort from a late in-flight chunk).
   */
  push(text: string): DegenerateStreamVerdict | null;
  /** Total chars observed. Useful for logging alongside a verdict. */
  totalChars(): number;
}

/**
 * Measure how far back from the end of `tail` the text stays periodic with
 * `period`, in chars. Exact match only: a degenerate loop repeats byte-for-byte,
 * and tolerating drift is what would let legitimate near-repetition trip.
 */
function periodicRunLength(tail: string, period: number): number {
  let matched = 0;
  for (let i = tail.length - 1; i - period >= 0; i--) {
    if (tail[i] !== tail[i - period]) break;
    matched++;
  }
  // `matched` counts positions with a predecessor one period back; the run
  // includes that first period itself.
  return matched > 0 ? matched + period : 0;
}

export function createDegenerateStreamGuard(options: DegenerateStreamGuardOptions = {}): DegenerateStreamGuard {
  const cfg = { ...DEFAULTS, ...options };
  let tail = '';
  let total = 0;
  let sinceCheck = 0;
  let tripped = false;

  return {
    totalChars: () => total,

    push(text: string): DegenerateStreamVerdict | null {
      if (!cfg.enabled || tripped || !text) return null;

      total += text.length;
      sinceCheck += text.length;
      tail = (tail + text).slice(-cfg.windowChars);

      if (sinceCheck < cfg.checkEveryChars) return null;
      sinceCheck = 0;

      // Not enough trailing text to contain a qualifying run yet.
      if (tail.length < cfg.minRunChars) return null;

      // Candidate period: distance back to the previous occurrence of the final
      // needle. In a loop that is exactly one cycle; in healthy text there is
      // usually no earlier copy at all, so this exits on one string search.
      const needle = tail.slice(-NEEDLE_CHARS);
      const prev = tail.lastIndexOf(needle, tail.length - NEEDLE_CHARS - 1);
      if (prev === -1) return null;

      const period = tail.length - NEEDLE_CHARS - prev;
      if (period <= 0 || period > cfg.maxPeriodChars) return null;

      const runChars = periodicRunLength(tail, period);
      const repeats = Math.floor(runChars / period);
      if (runChars < cfg.minRunChars || repeats < cfg.minRepeats) return null;

      tripped = true;
      return {
        unit: tail.slice(tail.length - period).slice(0, UNIT_LOG_LIMIT),
        periodChars: period,
        repeats,
        runChars,
        totalChars: total,
      };
    },
  };
}

/** Stable, user-facing explanation for a stream aborted by this guard. */
export const DEGENERATE_STREAM_MESSAGE =
  'The response stopped making progress and began repeating itself, so generation was ' +
  'halted early to avoid running to the output-token limit. The partial reply above is ' +
  'what completed before that point.';

/**
 * Normalized stop reason for a stream this guard aborted. Deliberately outside
 * the provider vocabulary in stopReason.ts (these are our own signals, not a
 * provider's) and deliberately NOT in the client's CLEAN_FINISH_REASONS, so the
 * reply renders with a truncation notice rather than as a clean finish.
 */
export const DEGENERATE_STREAM_STOP_REASON = 'degenerate_repetition';
