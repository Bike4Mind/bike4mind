import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import type { RequestHandler } from 'express';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';

/**
 * Per-minute limit at the caller's subscription tier. Pass a named `bucket` so a dynamic route
 * shares one counter per method instead of one per id.
 */
export const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user, req), windowMs: 60 * 1000, bucket });

/**
 * Keeps a route's own fixed per-minute cap but blocks the caller outright when their tier's
 * limit is 0, so the admin "0 blocks" setting reaches routes that must not inherit the tier
 * number itself (e.g. per-message helper calls that need more than the Free default).
 */
export const blockedAtZeroTierLimit =
  (fixedLimit: number) =>
  async (req: Parameters<RequestHandler>[0]): Promise<number> =>
    (await resolveUserRateLimitPerMin(req.user, req)) > 0 ? fixedLimit : 0;
