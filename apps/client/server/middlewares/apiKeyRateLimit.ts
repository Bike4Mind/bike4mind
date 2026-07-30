import { TooManyRequestsError } from '@bike4mind/utils';
import { RequestHandler } from 'express';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { ApiKeyScope } from '@bike4mind/common';

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
 * Headers added to response:
 * - X-RateLimit-Limit-Minute: Max requests per minute
 * - X-RateLimit-Remaining-Minute: Remaining requests this minute
 * - X-RateLimit-Reset-Minute: Unix timestamp when minute limit resets
 * - X-RateLimit-Limit-Day: Max requests per day
 * - X-RateLimit-Remaining-Day: Remaining requests today
 * - X-RateLimit-Reset-Day: Unix timestamp when day limit resets
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
          endpoint: req.originalUrl || req.url,
          method: req.method,
        },
        { meterDailyLimit }
      );

      // Add rate limit headers to response
      res.setHeader('X-RateLimit-Limit-Minute', result.headers['X-RateLimit-Limit-Minute']);
      res.setHeader('X-RateLimit-Remaining-Minute', result.headers['X-RateLimit-Remaining-Minute']);
      res.setHeader('X-RateLimit-Reset-Minute', result.headers['X-RateLimit-Reset-Minute']);
      res.setHeader('X-RateLimit-Limit-Day', result.headers['X-RateLimit-Limit-Day']);
      res.setHeader('X-RateLimit-Remaining-Day', result.headers['X-RateLimit-Remaining-Day']);
      res.setHeader('X-RateLimit-Reset-Day', result.headers['X-RateLimit-Reset-Day']);

      // If rate limit exceeded, set Retry-After header and throw error
      if (!result.allowed) {
        if (result.retryAfter) {
          res.setHeader('Retry-After', result.retryAfter);
        }
        // Emit per-product RateLimitHit metric for ingest keys so the Overwatch ops dashboard
        // can surface per-product rate pressure without a separate Lambda.
        if (req.apiKeyInfo?.scopes?.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE) && req.apiKeyInfo.productId) {
          emitMetric(
            'Lumina5/OverwatchIngest',
            'RateLimitHit',
            1,
            { productId: req.apiKeyInfo.productId },
            StandardUnit.Count
          ).catch(() => {});
        }
        throw new TooManyRequestsError(result.error || 'Rate limit exceeded');
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
