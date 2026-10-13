export const POLL_BACKOFF_SECONDS = [5, 10, 20, 30, 60] as const;
export const MAX_STEP_ATTEMPTS = 5;

export const pollDelaySeconds = (pollCount: number): number =>
  POLL_BACKOFF_SECONDS[Math.min(Math.max(pollCount, 0), POLL_BACKOFF_SECONDS.length - 1)];
