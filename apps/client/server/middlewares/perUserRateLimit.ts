import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';

/**
 * Per-minute limit at the caller's subscription tier. Pass a named `bucket` so a dynamic route
 * shares one counter per method instead of one per id.
 */
export const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });
