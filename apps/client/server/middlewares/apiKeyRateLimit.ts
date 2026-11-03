import { TooManyRequestsError } from '@bike4mind/utils';
import { loadShadowTierSettings } from '@bike4mind/services/llm/shadowTier';
import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { RequestHandler } from 'express';
import { checkApiKeyRateLimit, type RateLimitCounter } from '@server/utils/apiKeyRateLimitCheck';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { ApiKeyScope, API_KEY_RATE_LIMIT_HEADER_NAMES, isShadowTier } from '@bike4mind/common';
import { persistedIsAdmin } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { resolveRouteTemplate } from '@server/utils/resolveRouteTemplate';

export interface ApiKeyRateLimitOptions {
  /**
   * When true, this route's SAFE (idempotent) requests - GET/HEAD/OPTIONS - do
   * not consume the per-DAY quota; they still count toward the per-minute burst
   * limit. Use for async job-status polls and content fetches, which would
   * otherwise burn the daily budget meant to meter generation submissions.
   * Defaults to false: every request counts, so unaudited routes fail safe
   * (an expensive GET keeps its daily cap unless a route explicitly opts in).
   */
  exemptReadsFromDailyLimit?: boolean;
  /**
   * Which counter to charge this route's API-key requests to. Defaults to
   * 'request' (the key's configured quota). 'management' is for key-admin
   * routes that must stay reachable with an exhausted key.
   */
  counter?: RateLimitCounter;
}

/** RFC 7231 safe methods: no state change, so cheap to serve and safe to exempt. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Middleware to enforce API key-specific rate limits
 *
 * This middleware:
 * 1. Checks if request is authenticated via API key (req.apiKeyInfo exists)
 * 2. Enforces both per-minute and per-day rate limits configured on the API key
 * 3. Updates usage counters atomically in cache
 * 4. Returns 429 with Retry-After header when limits are exceeded
 * 5. Adds X-RateLimit-* headers to all API key authenticated responses
 * 6. Logs analytics events when rate limits are exceeded
 *
 * Rate limits are stored in MongoDB cache with TTL:
 * - Per-minute counter: 60 second TTL
 * - Per-day counter: 24 hour TTL
 *
 * Sets every header in API_KEY_RATE_LIMIT_HEADERS (b4m-core/common/src/apiKeyRateLimitHeaders.ts).
 */
export const apiKeyRateLimit =
  (options: ApiKeyRateLimitOptions = {}): RequestHandler =>
  async (req, res, next) => {
    // Only apply to API key authenticated requests
    if (!req.apiKeyInfo) {
      return next();
    }

    const { keyId, rateLimit } = req.apiKeyInfo;

    // A route can exempt its cheap reads from the day quota; only safe methods
    // actually qualify, so a POST on an opted-in route still counts.
    const meterDailyLimit = !(options.exemptReadsFromDailyLimit && SAFE_METHODS.has(req.method.toUpperCase()));

    try {
      // Check rate limit with context for analytics logging
      const result = await checkApiKeyRateLimit(
        keyId,
        rateLimit,
        {
          userId: req.user?.id,
          endpoint: resolveRouteTemplate(req),
          method: req.method,
        },
        { meterDailyLimit, counter: options.counter }
      );

      for (const header of API_KEY_RATE_LIMIT_HEADER_NAMES) {
        res.setHeader(header, result.headers[header]);
      }

      // If rate limit exceeded, set Retry-After header and throw error
      if (!result.allowed) {
        if (result.retryAfter) {
          res.setHeader('Retry-After', result.retryAfter);
        }
        // Emit per-product RateLimitHit metric for ingest keys so the Overwatch ops dashboard
        // can surface per-product rate pressure without a separate Lambda.
        if (req.apiKeyInfo?.scopes?.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE) && req.apiKeyInfo.productId) {
          // Awaited: the 429 ends the invocation, and a frozen Lambda loses a pending emit.
          await emitMetric(
            'Lumina5/OverwatchIngest',
            'RateLimitHit',
            1,
            { productId: req.apiKeyInfo.productId },
            StandardUnit.Count
          );
        }
        throw new TooManyRequestsError(result.error || 'Rate limit exceeded');
      }

      // Restricted tier: a separate counter, so the key's advertised limit never reveals it. A hit
      // looks like the owner's per-user tier limit (middlewares/rateLimit.ts), not the key's.
      if (
        req.user &&
        isShadowTier({ isAdmin: persistedIsAdmin(req.user), tags: req.user.tags, throttle: req.user.throttle })
      ) {
        const { requestsPerMin } = await loadShadowTierSettings(adminSettingsRepository);
        const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
          `rate-limit:${req.user.id}:shadow-api-key`,
          requestsPerMin,
          60_000
        );
        if (!success) {
          const retryAfter = Math.max(1, Math.ceil(Math.max(0, expiresAt.getTime() - Date.now()) / 1000));
          res.setHeader('Retry-After', retryAfter);
          throw new TooManyRequestsError(`Rate limit exceeded. Try again in ${retryAfter} seconds.`);
        }
      }

      return next();
    } catch (error) {
      // If it's a TooManyRequestsError, pass it through
      if (error instanceof TooManyRequestsError) {
        return next(error);
      }

      // For other errors (e.g., database connection issues), log and pass through
      console.error('[API_KEY_RATE_LIMIT] Error checking rate limit:', error);
      return next(error);
    }
  };
