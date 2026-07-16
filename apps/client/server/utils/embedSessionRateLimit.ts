import { cacheRepository } from '@bike4mind/database';

const MINUTE_IN_MS = 60_000;
const DAY_IN_MS = 86_400_000;

export interface EmbedSessionRateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  error?: string;
}

function retrySeconds(expiresAt: Date): number {
  return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
}

/**
 * Per-session rate limit for the embed chat surface, keyed on the minted session
 * token's `sessionId` - a distinct namespace from `api-key-rate-limit:`, so it
 * bounds a single browser session on top of (not instead of) the per-key limit.
 * One abusive visitor therefore cannot drain the whole key's budget. Fixed-window
 * minute + day counters on the shared atomic cache (coherent across Lambda/Fargate
 * containers), mirroring checkApiKeyRateLimit's semantics on a separate key space.
 *
 * Only the token path carries a sessionId; the raw-key (server-to-server) path
 * relies on the per-key + per-IP limits instead.
 */
export async function checkEmbedSessionRateLimit(
  sessionId: string,
  limits: { requestsPerMinute: number; requestsPerDay: number }
): Promise<EmbedSessionRateLimitResult> {
  const minuteKey = `embed-session-rate-limit:${sessionId}:minute`;
  const dayKey = `embed-session-rate-limit:${sessionId}:day`;

  const minute = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    minuteKey,
    limits.requestsPerMinute,
    MINUTE_IN_MS
  );
  if (!minute.success) {
    const retryAfter = retrySeconds(minute.expiresAt);
    return {
      allowed: false,
      retryAfter,
      error: `Rate limit exceeded: ${limits.requestsPerMinute} requests per minute. Try again in ${retryAfter} seconds.`,
    };
  }

  const day = await cacheRepository.tryIncrementWithinLimitFixedWindow(dayKey, limits.requestsPerDay, DAY_IN_MS);
  if (!day.success) {
    // Roll back the minute increment we just consumed so a day-limit rejection
    // does not also burn a minute slot the caller never got to use.
    await cacheRepository.decrementCounter(minuteKey);
    const retryAfter = retrySeconds(day.expiresAt);
    return {
      allowed: false,
      retryAfter,
      error: `Rate limit exceeded: ${limits.requestsPerDay} requests per day. Try again in ${retryAfter} seconds.`,
    };
  }

  return { allowed: true };
}
