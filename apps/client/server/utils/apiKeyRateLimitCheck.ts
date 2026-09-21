import { cacheRepository } from '@bike4mind/database';
import { UserApiKeyEvents, IUserApiKeyRateLimit } from '@bike4mind/common';
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

/**
 * Which counter a request is charged to. 'request' is the key's configured
 * quota - the default for all ordinary traffic. 'management' is a small,
 * separate quota used only by key-administration routes, so a key whose own
 * request window is exhausted can still call the route that would raise it.
 */
export type RateLimitCounter = 'request' | 'management';

/**
 * Ceilings for the 'management' counter. Fixed rather than key-configurable:
 * these routes only mutate key metadata and cannot consume model spend, so the
 * quota exists to bound abuse, not to meter cost. Small enough that it is
 * never a useful amplification target, generous enough for a client that
 * retries a ceiling change a few times.
 */
export const MANAGEMENT_RATE_LIMIT = {
  requestsPerMinute: 5,
  requestsPerDay: 50,
} as const;

/**
 * Which ceiling actually gates a counter: the key's own configured limit for
 * 'request', or the fixed `MANAGEMENT_RATE_LIMIT` for 'management'. The single
 * source of truth for that mapping - both the enforcer (`checkApiKeyRateLimit`)
 * and the admin reset's lockout diagnostic must agree on it, or the diagnostic
 * could silently report against a ceiling that no longer gates 429s.
 */
export function resolveCounterLimit(counter: RateLimitCounter, rateLimit: IUserApiKeyRateLimit): IUserApiKeyRateLimit {
  return counter === 'management' ? MANAGEMENT_RATE_LIMIT : rateLimit;
}

export interface RateLimitOptions {
  /**
   * Which counter to charge this request to. Defaults to 'request' (the key's
   * own configured quota). See {@link RateLimitCounter}.
   */
  counter?: RateLimitCounter;
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
export function buildRateLimitKeys(
  keyId: string,
  counter: RateLimitCounter = 'request'
): { minuteKey: string; dayKey: string } {
  // The default counter keeps its original, unnamespaced key format so live
  // windows are not orphaned by this function gaining a second counter.
  const scope = counter === 'request' ? '' : `${counter}:`;
  return {
    minuteKey: `api-key-rate-limit:${keyId}:${scope}minute`,
    dayKey: `api-key-rate-limit:${keyId}:${scope}day`,
  };
}

export interface RateLimitUsage {
  minute: number;
  day: number;
  /** Epoch seconds when the current minute window ends; undefined when no window is open (count 0). */
  minuteResetAt?: number;
  /** Epoch seconds when the current day window ends; undefined when no window is open (count 0). */
  dayResetAt?: number;
}

export interface ResetApiKeyRateLimitResult {
  /**
   * Usage at the moment this counter was cleared. Undefined when this
   * counter could not be fully verified - EITHER of its minute/day deletes
   * rejected. A single rejected leg is not reported as usage 0: the window
   * it covers was never actually read, so 0 would fabricate "not at
   * ceiling" for a counter that might still be locked. The other counter is
   * cleared and reported independently regardless, so a hiccup on one never
   * hides or blocks the other; `resetApiKeyRateLimit` itself rejects only
   * when NEITHER counter's clear made any progress at all (see its
   * docstring), so a caller that gets a result back knows at least one
   * underlying delete genuinely succeeded somewhere.
   */
  request?: RateLimitUsage;
  /** Present only when `alsoResetManagement` was set; same failure semantics as `request`. */
  management?: RateLimitUsage;
}

/** Minimal logging surface `resetApiKeyRateLimit` needs - satisfied by both `console` and a
 * request-scoped logger, so callers with request correlation (e.g. `req.logger`) can pass it
 * through instead of every failure landing in `console.warn` with no way to trace it back. */
interface CounterLogger {
  warn: (message: string) => void;
}

/** Result of clearing one counter's minute+day pair. `usage` and `cleared` are tracked
 * separately on purpose: a single failed leg makes `usage` unverifiable (undefined) without
 * meaning nothing happened - the sibling leg may well have genuinely cleared. `cleared` is
 * what `resetApiKeyRateLimit` checks to tell "nothing succeeded anywhere" (reject) apart from
 * "something succeeded, but we can't fully vouch for the reported numbers" (return, flagged
 * unverified). */
interface CounterClearResult {
  usage: RateLimitUsage | undefined;
  cleared: boolean;
}

/**
 * Clear a key's minute and day rate-limit counters, returning each counter's
 * usage exactly as it stood at the moment of deletion. Uses
 * `deleteByKeyAndReturn` (an atomic `findOneAndDelete`) rather than a
 * separate read-then-delete, so there is no window in which a concurrent
 * request can bump a counter between "read its value" and "clear it" - the
 * value returned here IS the value that was cleared, not a stale snapshot.
 * Deleting a missing doc is a no-op (idempotent) and reads as usage 0.
 *
 * The request and management counters are cleared independently (two
 * separate minute+day pairs, each with its own error boundary): a failure
 * clearing one never prevents clearing - or reporting - the other. This
 * route is the only operator override for a key locked out of its own
 * management quota, so a transient failure on one counter must never block
 * recovery of the other. But if NOTHING cleared anywhere - every minute and
 * day delete across every attempted counter failed - that is not a partial
 * degradation, the reset did nothing, so this rejects instead of returning a
 * result a caller could mistake for success.
 *
 * Note: embed keys additionally have per-session counters
 * (`embed-session-rate-limit:{sessionId}:minute|:day`, see ./embedSessionRateLimit)
 * - this deliberately never touches those.
 *
 * By default this also leaves the 'management' counter alone: a routine reset
 * restores the key's request budget, and the management quota is not the
 * budget anyone is asking to have restored. Pass `alsoResetManagement: true`
 * for the one caller that needs the exception - the admin reset endpoint. If
 * a client exhausts the management counter itself (a retry loop, a scripted
 * ceiling bump across keys), the self-service rate-limit PATCH - the only API
 * path back - starts 429ing, and a routine reset would be a no-op against the
 * counter that's actually stuck, leaving no operator override for up to 24h.
 */
export async function resetApiKeyRateLimit(
  keyId: string,
  options: { alsoResetManagement?: boolean; logger?: CounterLogger } = {}
): Promise<ResetApiKeyRateLimitResult> {
  const logger = options.logger ?? console;
  const { minuteKey, dayKey } = buildRateLimitKeys(keyId);
  const request = deleteCounterGroup(keyId, 'request', minuteKey, dayKey, logger);

  let management: Promise<CounterClearResult> | undefined;
  if (options.alsoResetManagement) {
    const { minuteKey: managementMinuteKey, dayKey: managementDayKey } = buildRateLimitKeys(keyId, 'management');
    management = deleteCounterGroup(keyId, 'management', managementMinuteKey, managementDayKey, logger);
  }

  const [requestResult, managementResult] = await Promise.all([request, management ?? Promise.resolve(undefined)]);

  if (!requestResult.cleared && !(managementResult?.cleared ?? false)) {
    throw new Error(`Failed to clear any rate-limit counters for API key ${keyId} - every counter delete failed`);
  }

  return { request: requestResult.usage, management: managementResult?.usage };
}

/**
 * Delete a counter's minute+day pair atomically per key (via
 * `deleteByKeyAndReturn`) and derive its usage from what was actually
 * removed. The two deletes settle independently (`Promise.allSettled`, not a
 * fail-fast `Promise.all`) so a rejection on one leg can never abort the
 * other - both are always attempted. But if EITHER leg rejects, `usage` comes
 * back undefined rather than a value built from only the leg that succeeded:
 * the failed leg's window was never actually read, so reporting it as 0
 * would fabricate "not at ceiling" for a counter that might still be at its
 * limit. `cleared` is reported separately - true as long as at least one leg
 * didn't error - so a caller can still tell "something genuinely happened
 * here" apart from "the reported numbers are fully trustworthy".
 */
async function deleteCounterGroup(
  keyId: string,
  counter: RateLimitCounter,
  minuteKey: string,
  dayKey: string,
  logger: CounterLogger
): Promise<CounterClearResult> {
  const [minuteResult, dayResult] = await Promise.allSettled([
    cacheRepository.deleteByKeyAndReturn(minuteKey),
    cacheRepository.deleteByKeyAndReturn(dayKey),
  ]);

  const warn = (message: string) => {
    try {
      logger.warn(message);
    } catch {
      // A broken logger must never turn an otherwise-successful clear into a failure.
    }
  };
  if (minuteResult.status === 'rejected') {
    warn(`[API_KEY_RATE_LIMIT] Failed to clear ${counter} minute counter for API key ${keyId}: ${minuteResult.reason}`);
  }
  if (dayResult.status === 'rejected') {
    warn(`[API_KEY_RATE_LIMIT] Failed to clear ${counter} day counter for API key ${keyId}: ${dayResult.reason}`);
  }

  const cleared = minuteResult.status === 'fulfilled' || dayResult.status === 'fulfilled';

  if (minuteResult.status === 'rejected' || dayResult.status === 'rejected') {
    return { usage: undefined, cleared };
  }

  return { usage: docsToUsage(minuteResult.value, dayResult.value), cleared };
}

function docsToUsage(
  minuteDoc: { result?: unknown; expiresAt?: Date } | null | undefined,
  dayDoc: { result?: unknown; expiresAt?: Date } | null | undefined
): RateLimitUsage {
  const minute = readCounter(minuteDoc ?? null);
  const day = readCounter(dayDoc ?? null);
  return {
    minute: minute.count,
    day: day.count,
    minuteResetAt: minute.resetAt,
    dayResetAt: day.resetAt,
  };
}

/**
 * Read a key's current 'request' counter minute and day values without
 * touching them. A missing doc, or one whose fixed window already ended
 * (expiresAt in the past, awaiting TTL cleanup), reads as 0 - the same view
 * the enforcer takes on the next request. The DB usage.* fields on the key
 * doc are not maintained; these cache counters are the live source of truth.
 * No 'management' variant: the admin reset's lockout diagnostic derives
 * management usage from `resetApiKeyRateLimit`'s own atomic delete instead of
 * a separate read (see its docstring), and no other caller needs one.
 */
export async function getApiKeyRateLimitUsage(keyId: string): Promise<RateLimitUsage> {
  const { minuteKey, dayKey } = buildRateLimitKeys(keyId);
  const [minuteDoc, dayDoc] = await Promise.all([
    cacheRepository.findByKey(minuteKey),
    cacheRepository.findByKey(dayKey),
  ]);
  return docsToUsage(minuteDoc, dayDoc);
}

export interface CounterLockoutState {
  minuteAtLimit: boolean;
  dayAtLimit: boolean;
}

/**
 * Whether a counter's live usage is at or over its ceiling - i.e. would
 * currently cause a 429. Read-only, does not touch the counters. Exists so an
 * admin resetting a key can be told which counter(s) actually caused the
 * lockout, since resetApiKeyRateLimit clears that state and it can't be
 * recovered afterward.
 */
export function evaluateCounterLockout(usage: RateLimitUsage, limit: IUserApiKeyRateLimit): CounterLockoutState {
  return {
    minuteAtLimit: usage.minute >= limit.requestsPerMinute,
    dayAtLimit: usage.day >= limit.requestsPerDay,
  };
}

/**
 * Read a counter doc's live count and window-end (epoch seconds). A missing,
 * expired-but-uncleaned, or malformed doc reads as count 0 with no reset - the
 * window is effectively closed, so there is nothing to reset.
 */
function readCounter(doc: { result?: unknown; expiresAt?: Date } | null): { count: number; resetAt?: number } {
  if (!doc || (doc.expiresAt && doc.expiresAt.getTime() <= Date.now())) {
    return { count: 0 };
  }
  const count = (doc.result as { count?: unknown } | undefined)?.count;
  if (typeof count !== 'number') {
    return { count: 0 };
  }
  return { count, resetAt: doc.expiresAt ? Math.floor(doc.expiresAt.getTime() / 1000) : undefined };
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
 * @param rateLimit - The rate limit configuration from the API key (ignored when
 *   `options.counter` is 'management', which has its own fixed ceilings)
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
  const { meterDailyLimit = true, counter = 'request' } = options;
  // A management request is charged to its own counter with its own fixed
  // ceilings, so an exhausted request window neither blocks it nor is advanced
  // by it.
  const { requestsPerMinute, requestsPerDay } = resolveCounterLimit(counter, rateLimit);
  // What the response advertises as the Limit is always the key's own
  // configured ceiling, even on the management counter - the caller of a
  // management-metered route (the self-service rate-limit PATCH) is reading
  // limits back to confirm what it just configured, and a fixed 5/50 there
  // reads as "your write got clamped" rather than "a different counter paid
  // for this request". Remaining/Reset stay tied to whichever ceiling is
  // actually enforced, since that's what governs the next 429.
  const { requestsPerMinute: reportedRequestsPerMinute, requestsPerDay: reportedRequestsPerDay } = rateLimit;

  try {
    const { minuteKey, dayKey } = buildRateLimitKeys(keyId, counter);

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
        headers: buildHeaders({
          minuteLimit: requestsPerMinute,
          minuteCount: minuteResult.count,
          minuteResetAt,
          dayLimit: requestsPerDay,
          dayCount: 0, // Day counter untouched on a minute-limit rejection
          dayResetAt: Date.now() + DAY_IN_MS, // Nominal; the day header is informational here
          reportedMinuteLimit: reportedRequestsPerMinute,
          reportedDayLimit: reportedRequestsPerDay,
        }),
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
        headers: buildHeaders({
          minuteLimit: requestsPerMinute,
          minuteCount: minuteResult.count,
          minuteResetAt,
          dayLimit: requestsPerDay,
          dayCount,
          dayResetAt,
          reportedMinuteLimit: reportedRequestsPerMinute,
          reportedDayLimit: reportedRequestsPerDay,
        }),
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
        headers: buildHeaders({
          minuteLimit: requestsPerMinute,
          minuteCount: minuteResult.count - 1, // Account for rollback
          minuteResetAt,
          dayLimit: requestsPerDay,
          dayCount: dayResult.count,
          dayResetAt,
          reportedMinuteLimit: reportedRequestsPerMinute,
          reportedDayLimit: reportedRequestsPerDay,
        }),
      };
    }

    // Success - both counters incremented atomically
    return {
      allowed: true,
      headers: buildHeaders({
        minuteLimit: requestsPerMinute,
        minuteCount: minuteResult.count,
        minuteResetAt,
        dayLimit: requestsPerDay,
        dayCount: dayResult.count,
        dayResetAt,
        reportedMinuteLimit: reportedRequestsPerMinute,
        reportedDayLimit: reportedRequestsPerDay,
      }),
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

interface BuildHeadersParams {
  /** Enforced ceiling: what the counter is actually metered against. */
  minuteLimit: number;
  minuteCount: number;
  minuteResetAt: number;
  /** Enforced ceiling: what the counter is actually metered against. */
  dayLimit: number;
  dayCount: number;
  dayResetAt: number;
  /**
   * Value advertised in X-RateLimit-Limit-Minute/-Day - always the key's own
   * configured ceiling, which diverges from the enforced one on the
   * 'management' counter. Required rather than defaulted: the two are equal
   * for the 'request' counter, and letting a caller omit it is how the
   * management path silently regresses to advertising the fixed 5/50.
   */
  reportedMinuteLimit: number;
  reportedDayLimit: number;
}

/**
 * Build rate limit headers for response
 */
function buildHeaders(params: BuildHeadersParams): RateLimitResult['headers'] {
  const {
    minuteLimit,
    minuteCount,
    minuteResetAt,
    dayLimit,
    dayCount,
    dayResetAt,
    reportedMinuteLimit,
    reportedDayLimit,
  } = params;
  // Remaining is clamped to the advertised limit as well as the enforced one:
  // a key may be configured BELOW the management ceiling (limits validate at
  // min 1), and reporting more headroom than the advertised limit allows is
  // the same class of confusion the reported limit exists to remove. Accepted
  // tradeoff: for such a key, Remaining holds flat at the reported limit
  // across the first several management-metered calls and only drops once
  // the enforced counter nears its own ceiling - it does not decrement 1:1
  // with usage in that band. Remaining <= Limit still always holds, and the
  // enforced counter (not this header) is what actually gates the 429.
  return {
    'X-RateLimit-Limit-Minute': reportedMinuteLimit,
    'X-RateLimit-Remaining-Minute': Math.min(reportedMinuteLimit, Math.max(0, minuteLimit - minuteCount)),
    'X-RateLimit-Reset-Minute': Math.floor(minuteResetAt / 1000),
    'X-RateLimit-Limit-Day': reportedDayLimit,
    'X-RateLimit-Remaining-Day': Math.min(reportedDayLimit, Math.max(0, dayLimit - dayCount)),
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
