import { TooManyRequestsError } from '@bike4mind/utils';
import { RequestHandler } from 'express';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { emitMetric } from '@server/utils/cloudwatch';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { ApiKeyScope } from '@bike4mind/common';

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
export const apiKeyRateLimit = (): RequestHandler => async (req, res, next) => {
  // Only apply to API key authenticated requests
  if (!req.apiKeyInfo) {
    return next();
  }

  const { keyId, rateLimit } = req.apiKeyInfo;

  try {
    // Check rate limit with context for analytics logging
    const result = await checkApiKeyRateLimit(keyId, rateLimit, {
      userId: req.user?.id,
      endpoint: req.originalUrl || req.url,
      method: req.method,
    });

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
