import { cacheRepository } from '@bike4mind/database';
import { UserApiKeyEvents } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';

const MINUTE_IN_MS = 60_000;
const DAY_IN_MS = 86_400_000;
const MIN_RETRY_AFTER_SECONDS = 1;

export interface RateLimitResult {
  allowed: boolean;
  error?: string;
  retryAfter?: number;
  limitType?: 'minute' | 'day';
  currentCount?: number;
  headers: {
    'X-RateLimit-Limit-Minute': number;
    'X-RateLimit-Remaining-Minute': number;
    'X-RateLimit-Reset-Minute': number;
    'X-RateLimit-Limit-Day': number;
    'X-RateLimit-Remaining-Day': number;
    'X-RateLimit-Reset-Day': number;
  };
}

export interface RateLimitContext {
  userId?: string;
  endpoint: string;
  method: string;
}

export interface RateLimitOptions {
  /**
   * Whether this request should consume the per-DAY quota. Defaults to true.
   * Set false for cheap idempotent reads (async job-status polls, content
   * fetches) so they don't burn the daily budget that meters actual generation
   * submissions. The per-MINUTE burst limit still applies regardless, so a
   * runaway poll loop is still throttled. The caller (middleware) owns the
   * policy of which requests qualify; this function only honors the flag.
   */
  meterDailyLimit?: boolean;
}

/**
 * Single source of truth for the rate-limit cache key format. Both the
 * enforcer (checkApiKeyRateLimit) and the reset (resetApiKeyRateLimit) must
 * derive keys from here so they can never desync.
 */
export function buildRateLimitKeys(keyId: string): { minuteKey: string; dayKey: string } {
  return {
    minuteKey: `api-key-rate-limit:${keyId}:minute`,
    dayKey: `api-key-rate-limit:${keyId}:day`,
  };
}

/**
 * Clear a key's minute and day rate-limit counters. Deleting the cache docs
 * also discards each window's stored expiresAt, so the next request opens a
 * fresh fixed window - the intended "reset" semantics. deleteByKey is an
 * exact-match deleteOne, so unrelated cache keys are never touched, and
 * deleting a missing doc is a no-op (idempotent).
 *
 * Note: embed keys additionally have per-session counters
 * (`embed-session-rate-limit:{sessionId}:minute|:day`, see ./embedSessionRateLimit)
 * which this deliberately does not clear.
 */
export async function resetApiKeyRateLimit(keyId: string): Promise<void> {
  const { minuteKey, dayKey } = buildRateLimitKeys(keyId);
  await cacheRepository.deleteByKey(minuteKey);
  await cacheRepository.deleteByKey(dayKey);
}

export interface RateLimitUsage {
  minute: number;
  day: number;
}

/**
 * Read a key's current minute and day counter values without touching them.
 * A missing doc, or one whose fixed window already ended (expiresAt in the
 * past, awaiting TTL cleanup), reads as 0 - the same view the enforcer takes
 * on the next request. The DB usage.* fields on the key doc are not
 * maintained; these cache counters are the live source of truth.
 */
export async function getApiKeyRateLimitUsage(keyId: string): Promise<RateLimitUsage> {
  const { minuteKey, dayKey } = buildRateLimitKeys(keyId);
  const [minuteDoc, dayDoc] = await Promise.all([
    cacheRepository.findByKey(minuteKey),
    cacheRepository.findByKey(dayKey),
  ]);
  return { minute: readCounterValue(minuteDoc), day: readCounterValue(dayDoc) };
}

function readCounterValue(doc: { result?: unknown; expiresAt?: Date } | null): number {
  if (!doc || (doc.expiresAt && doc.expiresAt.getTime() <= Date.now())) {
    return 0;
  }
  const count = (doc.result as { count?: unknown } | undefined)?.count;
  return typeof count === 'number' ? count : 0;
}

/**
 * Atomically increment a rate-limit counter ONLY if under limit, using
 * FIXED-WINDOW semantics: the window opens on the first request and closes
 * deterministically `ttlMs` later. Crucially the expiry is NOT pushed forward
 * on each increment - otherwise a continuously-active key (e.g. an hourly cron
 * pipeline) slides its day window forward forever, the counter never resets,
 * and it climbs monotonically until it permanently sticks at the ceiling.
 * Mirrors the general request limiter in `middlewares/rateLimit.ts`.
 *
 * @returns success/count plus the window's real `expiresAt` (for Retry-After)
 */
async function tryIncrementFixedWindow(
  key: string,
  limit: number,
  ttlMs: number
): Promise<{ success: boolean; count: number; expiresAt: Date }> {
  return cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, ttlMs);
}

/**
 * Atomically decrement a counter (used for rollback)
 *
 * @param key - Cache key for the counter
 * @returns Current count after decrement
 */
async function decrementCounter(key: string): Promise<number> {
  return cacheRepository.decrementCounter(key);
}

/**
 * Check API key rate limits with atomic, fixed-window conditional increments.
 * Safe under concurrent load (each check+increment is one atomic Mongo op per
 * counter) AND immune to the sliding-window trap: every window resets a fixed
 * `ttlMs` after it opened, so a steadily-active key's day counter resets daily
 * instead of accumulating to the ceiling forever.
 *
 * @param keyId - The API key ID to check
 * @param rateLimit - The rate limit configuration from the API key
 * @param context - Optional context for analytics logging (userId, endpoint, method)
 * @param options - Enforcement options (e.g. exempt cheap reads from the day quota)
 * @returns RateLimitResult with allowed status, headers, and error if exceeded
 */
export async function checkApiKeyRateLimit(
  keyId: string,
  rateLimit: { requestsPerMinute: number; requestsPerDay: number },
  context?: RateLimitContext,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  const { requestsPerMinute, requestsPerDay } = rateLimit;
  const { meterDailyLimit = true } = options;

  try {
    const { minuteKey, dayKey } = buildRateLimitKeys(keyId);

    // Step 1: Atomically try to increment the minute counter (only if under
    // limit). The returned expiresAt is the real window end -> exact Retry-After.
    const minuteResult = await tryIncrementFixedWindow(minuteKey, requestsPerMinute, MINUTE_IN_MS);
    const minuteResetAt = minuteResult.expiresAt.getTime();
    const minuteResetSeconds = resetSecondsFrom(minuteResetAt, MINUTE_IN_MS);

    if (!minuteResult.success) {
      // Minute limit exceeded - reject immediately
      await logRateLimitEvent(context, keyId, 'minute', requestsPerMinute, minuteResult.count);

      return {
        allowed: false,
        error: `Rate limit exceeded: ${requestsPerMinute} requests per minute. Try again in ${minuteResetSeconds} seconds.`,
        retryAfter: minuteResetSeconds,
        limitType: 'minute',
        currentCount: minuteResult.count,
        headers: buildHeaders(
          requestsPerMinute,
          minuteResult.count,
          minuteResetAt,
          requestsPerDay,
          0, // Day counter untouched on a minute-limit rejection
          Date.now() + DAY_IN_MS // Nominal; the day header is informational here
        ),
      };
    }

    // Step 1b: Cheap reads (status polls, content fetches) are exempt from the
    // day quota. Don't touch the day counter - report its current value from a
    // non-incrementing read so the day headers stay honest.
    if (!meterDailyLimit) {
      const dayDoc = await cacheRepository.findByKey(dayKey);
      const dayCount = (dayDoc?.result as { count?: number } | undefined)?.count ?? 0;
      const dayResetAt = dayDoc?.expiresAt ? dayDoc.expiresAt.getTime() : Date.now() + DAY_IN_MS;

      return {
        allowed: true,
        headers: buildHeaders(
          requestsPerMinute,
          minuteResult.count,
          minuteResetAt,
          requestsPerDay,
          dayCount,
          dayResetAt
        ),
      };
    }

    // Step 2: Atomically try to increment the day counter (only if under limit)
    const dayResult = await tryIncrementFixedWindow(dayKey, requestsPerDay, DAY_IN_MS);
    const dayResetAt = dayResult.expiresAt.getTime();
    const dayResetSeconds = resetSecondsFrom(dayResetAt, DAY_IN_MS);

    if (!dayResult.success) {
      // Day limit exceeded - rollback minute counter and reject
      await decrementCounter(minuteKey);
      await logRateLimitEvent(context, keyId, 'day', requestsPerDay, dayResult.count);

      return {
        allowed: false,
        error: `Rate limit exceeded: ${requestsPerDay} requests per day. Try again in ${dayResetSeconds} seconds.`,
        retryAfter: dayResetSeconds,
        limitType: 'day',
        currentCount: dayResult.count,
        headers: buildHeaders(
          requestsPerMinute,
          minuteResult.count - 1, // Account for rollback
          minuteResetAt,
          requestsPerDay,
          dayResult.count,
          dayResetAt
        ),
      };
    }

    // Success - both counters incremented atomically
    return {
      allowed: true,
      headers: buildHeaders(
        requestsPerMinute,
        minuteResult.count,
        minuteResetAt,
        requestsPerDay,
        dayResult.count,
        dayResetAt
      ),
    };
  } catch (error) {
    console.error('[API_KEY_RATE_LIMIT] Error checking rate limit:', error);
    throw error;
  }
}

/**
 * Seconds until a window-end timestamp, clamped to a sane minimum. Falls back
 * to the full window if the stored expiry is already in the past (clock skew or
 * a window that just rolled over).
 */
function resetSecondsFrom(resetAtMs: number, windowMs: number): number {
  const remainingMs = resetAtMs - Date.now();
  return Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil((remainingMs > 0 ? remainingMs : windowMs) / 1000));
}

/**
 * Build rate limit headers for response
 */
function buildHeaders(
  requestsPerMinute: number,
  currentMinuteCount: number,
  minuteResetAt: number,
  requestsPerDay: number,
  currentDayCount: number,
  dayResetAt: number
): RateLimitResult['headers'] {
  return {
    'X-RateLimit-Limit-Minute': requestsPerMinute,
    'X-RateLimit-Remaining-Minute': Math.max(0, requestsPerMinute - currentMinuteCount),
    'X-RateLimit-Reset-Minute': Math.floor(minuteResetAt / 1000),
    'X-RateLimit-Limit-Day': requestsPerDay,
    'X-RateLimit-Remaining-Day': Math.max(0, requestsPerDay - currentDayCount),
    'X-RateLimit-Reset-Day': Math.floor(dayResetAt / 1000),
  };
}

/**
 * Log rate limit exceeded event to analytics
 */
async function logRateLimitEvent(
  context: RateLimitContext | undefined,
  keyId: string,
  limitType: 'minute' | 'day',
  limit: number,
  currentCount: number
): Promise<void> {
  if (!context?.userId) return;

  await logEvent({
    type: UserApiKeyEvents.RATE_LIMITED,
    userId: context.userId,
    metadata: {
      keyId,
      keyPrefix: keyId.substring(0, 16), // Increased from 12 to 16 for better security
      limitType,
      limit,
      endpoint: context.endpoint,
      method: context.method,
      currentCount,
    },
  }).catch(error => {
    // Don't fail the request if analytics logging fails
    console.error('[API_KEY_RATE_LIMIT] Failed to log rate limit event:', error);
  });
}

/**
 * Extract API key from request headers (case-insensitive)
 * Supports both X-API-Key and Authorization: ApiKey [key] formats
 *
 * @param headers - Request headers (can be from Express or Lambda)
 * @returns The API key string or null if not found
 */
export function extractApiKeyFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  // Normalize headers to lowercase for case-insensitive lookup
  const normalizedHeaders: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalizedHeaders[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && value.length > 0) {
      normalizedHeaders[key.toLowerCase()] = value[0];
    }
  }

  const xApiKey = normalizedHeaders['x-api-key'];
  if (xApiKey) {
    return xApiKey;
  }

  const authorization = normalizedHeaders['authorization'];
  if (authorization) {
    // Support "ApiKey <key>" format
    const apiKeyMatch = authorization.match(/^ApiKey\s+(.+)$/i);
    if (apiKeyMatch) {
      return apiKeyMatch[1];
    }

    // Support "Bearer b4m_*" format (API keys start with b4m_)
    const bearerMatch = authorization.match(/^Bearer\s+(b4m_\w+)$/i);
    if (bearerMatch) {
      return bearerMatch[1];
    }
  }

  return null;
}
