/**
 * The developer log: one buffer in main that anything in the app can publish to, and one
 * window that tails it.
 *
 * A record names no feature. It is a time, an open set of tags and a short message, plus a few
 * structured fields - so a new source is a call to the sink and nothing else: no change here,
 * no change to the window, no change to the filter.
 *
 * Nothing that reaches a record may contain a credential. See main/devlog/redact.ts: the sink
 * scrubs on the way IN, because a buffer holding a token is already a leak whether or not
 * anything renders it.
 */
export interface DevLogRecord {
  /** Monotonic within one app run. The window uses it to drop records a snapshot already had. */
  id: number;
  /** Epoch milliseconds. */
  at: number;
  /** Open set, discovered from what has been logged. Lower-case, no spaces. */
  tags: string[];
  message: string;
  fields?: Record<string, string | number | boolean>;
}

/** What a window gets when it opens, or after it asks for the buffer again. */
export interface DevLogSnapshot {
  records: DevLogRecord[];
  /** Records evicted by the ring buffer since the app started. */
  dropped: number;
}
