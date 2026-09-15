/**
 * Repeated-call circuit breaker for the ReAct loop.
 *
 * Guards against the non-terminating exploration loop where an agent re-issues
 * the SAME tool call with the SAME arguments and gets the SAME result over and
 * over (e.g. re-reading an unchanged file, or re-running a glob that always
 * returns "no files found"), burning tokens without making progress. History
 * trimming (`maxHistoryIterations`) means the agent literally cannot see that it
 * already did the work a few iterations back, so the loop is invisible to the
 * model - this guard tracks it out-of-band.
 *
 * Progress-aware by design: the repeat counter keys off the RESULT, not just the
 * call. When a call's result CHANGES (e.g. the file was edited, tests now pass,
 * a previously-missing route now exists) the counter resets - so legitimate
 * "act then re-check" loops are never penalized. Only a call that keeps
 * returning the identical result escalates toward the block.
 */

/** Append a warning to the observation once a call repeats this many times. */
export const DEFAULT_WARN_THRESHOLD = 3;
/** Stop executing and return only a nudge once a call repeats this many times. */
export const DEFAULT_BLOCK_THRESHOLD = 6;

export interface RepeatedCallGuardOptions {
  /** Set false to disable the guard entirely. Default: true (active). */
  enabled?: boolean;
  /**
   * Append a repetition warning to the observation once the same (tool, args)
   * call has returned the same result this many times. Default: 3.
   */
  warnThreshold?: number;
  /**
   * Stop executing the call and return only a nudge once the same (tool, args)
   * call has returned the same result this many times. Must be greater than
   * `warnThreshold` (the constructor throws otherwise). Default: 6.
   */
  blockThreshold?: number;
}

/** Outcome of recording an executed call. */
export interface RepeatedCallRecord {
  /** How many consecutive times this signature returned the same result. */
  count: number;
  /** Whether the caller should append a repetition warning to the observation. */
  warn: boolean;
}

/**
 * Deterministically serialize a value with object keys sorted, so semantically
 * identical argument objects produce the same signature regardless of key order
 * or incidental whitespace in the model's JSON.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** Normalize a tool's raw argument string into a stable, comparable form. */
function normalizeArgs(args: string | undefined): string {
  if (!args) return '';
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    // Not JSON (or malformed) - fall back to the trimmed raw string.
    return args.trim();
  }
}

/**
 * FNV-1a 32-bit hash. Keeps only a fixed-size fingerprint of each result rather
 * than the full (potentially large) tool output, so the guard's memory stays
 * bounded regardless of result size. A hash collision would at worst count two
 * different results as "the same" and warn/block slightly early - harmless for a
 * heuristic circuit breaker.
 */
function hashResult(result: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < result.length; i++) {
    hash ^= result.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class RepeatedCallGuard {
  private readonly enabled: boolean;
  private readonly warnThreshold: number;
  private readonly blockThreshold: number;
  private readonly history = new Map<string, { count: number; resultHash: number; isReadOnly: boolean }>();

  constructor(options: RepeatedCallGuardOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.warnThreshold = options.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
    this.blockThreshold = options.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD;
    // Fail fast on a misconfigured active guard: warnThreshold < 1 would warn
    // from the very first call, and blockThreshold <= warnThreshold makes the
    // warn phase dead (at 0 it blocks every tool after a single run). A disabled
    // guard never reads the thresholds, so their values are irrelevant to it.
    if (this.enabled) {
      if (this.warnThreshold < 1) {
        throw new RangeError(`RepeatedCallGuard: warnThreshold must be >= 1 (got ${this.warnThreshold}).`);
      }
      if (this.blockThreshold <= this.warnThreshold) {
        throw new RangeError(
          `RepeatedCallGuard: blockThreshold (${this.blockThreshold}) must be greater than warnThreshold (${this.warnThreshold}).`
        );
      }
    }
  }

  /** Clear all tracked history. Call at the start of every new run. */
  reset(): void {
    this.history.clear();
  }

  /** Stable signature for a tool call: tool name + normalized arguments. */
  static signature(toolName: string, args: string | undefined): string {
    return `${toolName}(${normalizeArgs(args)})`;
  }

  /** The repeat count at which execution is refused. */
  get blockLimit(): number {
    return this.blockThreshold;
  }

  /**
   * True once this exact call has already returned the same result
   * `blockThreshold` times - the caller should skip execution and return a
   * nudge instead of running the tool again.
   */
  shouldBlock(signature: string): boolean {
    if (!this.enabled) return false;
    const entry = this.history.get(signature);
    return entry !== undefined && entry.count >= this.blockThreshold;
  }

  /**
   * Record an executed call's result. Increments the repeat count when the
   * result is identical to the previous call with the same signature; resets to
   * 1 when the result changed (genuine progress). `isReadOnly` marks whether the
   * call had side effects, so `invalidateReadOnly()` can later clear only the
   * observation-style entries a subsequent mutation may have staled.
   */
  record(signature: string, result: string, isReadOnly = true): RepeatedCallRecord {
    if (!this.enabled) return { count: 1, warn: false };
    const hash = hashResult(result);
    const entry = this.history.get(signature);
    const count = entry && entry.resultHash === hash ? entry.count + 1 : 1;
    this.history.set(signature, { count, resultHash: hash, isReadOnly });
    return { count, warn: count >= this.warnThreshold };
  }

  /**
   * Drop the tracked history for read-only calls. Call after a mutating tool
   * runs: a write may have changed state that earlier reads sampled, so their
   * counts (and any block) must not carry over and wrongly suppress a follow-up
   * re-read of the thing that just changed. Mutating-call counts are preserved,
   * so a genuine write-spin (same write, same result, repeated) is still caught.
   */
  invalidateReadOnly(): void {
    if (!this.enabled) return;
    for (const [signature, entry] of this.history) {
      if (entry.isReadOnly) this.history.delete(signature);
    }
  }
}

/** Warning appended to a real observation once a call starts repeating. */
export function repeatedCallWarning(toolName: string, count: number): string {
  return (
    `\n\n[repeated-call notice] You have now made this exact "${toolName}" call ${count} times and ` +
    `received the same result each time. You already have this information - do not call it again. ` +
    `Move on to the next concrete action: make the edit/write your plan needs, call a different tool, ` +
    `or give your final answer.`
  );
}

/** Observation returned in place of execution once a call is blocked. */
export function repeatedCallBlockedObservation(toolName: string, blockLimit: number): string {
  return (
    `Circuit breaker: the tool "${toolName}" has already been called ${blockLimit} times with these ` +
    `exact arguments and returned the same result every time, so it was NOT run again. Re-running it ` +
    `cannot produce new information. Take a different, concrete action now: make the edit/write your ` +
    `plan requires, call a different tool, or give your final answer. If this call was checking a ` +
    `precondition (for example a file or route that does not exist yet), treat its absence as settled ` +
    `and proceed accordingly instead of re-checking it.`
  );
}
