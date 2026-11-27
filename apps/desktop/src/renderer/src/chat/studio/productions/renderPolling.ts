/**
 * How the Productions tab follows a render. Web polls every 5s behind a websocket; desktop has no
 * socket for render frames, so it polls alone, backing off as a render runs long and giving up
 * after a fixed number of checks (the export keeps running server-side; "Check again" resumes).
 */
export const RENDER_POLL = {
  initialMs: 2_000,
  factor: 1.5,
  maxMs: 15_000,
  /** About 35 minutes at the capped delay, past the longest render a 30-minute timeline needs. */
  maxPolls: 150,
} as const;

/** The wait before check number `attempt` (0-based). */
export function nextPollDelay(attempt: number): number {
  return Math.min(RENDER_POLL.maxMs, Math.round(RENDER_POLL.initialMs * RENDER_POLL.factor ** Math.max(0, attempt)));
}

/** A finished render's file can lag its job's success; the media read is retried this often, this many times. */
export const MEDIA_RETRY = { delayMs: 3_000, maxAttempts: 10 } as const;
