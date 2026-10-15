import { classifyModelCallError, type ModelCallErrorKind } from './modelCallError';

export type RetryDecision = { retry: false } | { retry: true; delayMs: number };

/** Maps a failed attempt (0-based) to whether and when to try again; injectable for tests. */
export type RetryDecider = (error: unknown, attempt: number) => RetryDecision;

/** Re-opens after the first attempt, so a call makes at most MAX_RETRIES + 1 requests. */
export const MAX_RETRIES = 3;

/** A Retry-After longer than this (ms) is surfaced instead of waited out with the user watching. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Each delay is scaled by a random factor in [1 - JITTER, 1 + JITTER], so clients don't retry in lockstep. */
const JITTER = 0.2;

/** First backoff (ms) per retryable kind; a struggling provider gets more room than a dropped socket. */
const BASE_DELAY_MS: Partial<Record<ModelCallErrorKind | 'empty', number>> = {
  unreachable: 500,
  network: 500,
  stream_idle: 500,
  empty: 500,
  rate_limited: 2_000,
  overloaded: 2_000,
  server: 2_000,
};

/**
 * Thrown when an attempt's stream ended without producing any content (no text, no tools) and
 * without a stop reason. Retryable; if every attempt comes back empty it surfaces to the caller
 * rather than delivering a blank turn.
 */
export class EmptyCompletionError extends Error {
  constructor() {
    super('Stream ended without producing any content.');
    this.name = 'EmptyCompletionError';
  }
}

/**
 * The single retry policy for a CLI model call: exponential backoff with jitter from a per-kind
 * base (at most 8 s before jitter, given MAX_RETRIES), never shorter than a server's Retry-After. Errors
 * with no retryable kind (auth, refusals, anything unclassified) are not retried.
 */
export function decideRetry(error: unknown, attempt: number, random: () => number = Math.random): RetryDecision {
  if (attempt >= MAX_RETRIES) return { retry: false };

  const classified = classifyModelCallError(error);
  const baseMs = BASE_DELAY_MS[error instanceof EmptyCompletionError ? 'empty' : (classified?.kind ?? 'refused')];
  if (baseMs === undefined) return { retry: false };

  const retryAfterMs = classified?.retryAfterMs;
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) return { retry: false };

  const backoffMs = baseMs * 2 ** attempt * (1 + JITTER * (2 * random() - 1));
  return { retry: true, delayMs: Math.round(Math.max(backoffMs, retryAfterMs ?? 0)) };
}
