import { cacheRepository } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import { RequestHandler } from 'express';
import { getClientIp } from '@server/utils/ip';

interface IRateLimitOptions {
  /**
   * Max requests allowed in the time window. Either a static number, or a
   * resolver evaluated per request against the authenticated user, used for
   * per-tier limits. A non-finite/non-positive resolved value (e.g.
   * `Infinity`) means "no limit" and skips enforcement (admins, dev server).
   */
  limit: number | ((req: Parameters<RequestHandler>[0]) => number | Promise<number>);
  /** How long to remember requests for, in milliseconds */
  windowMs: number;
  /**
   * Stable bucket name to use instead of the request pathname. REQUIRED for
   * dynamic routes (e.g. `/api/x/[id]`) where the raw pathname embeds the id -
   * otherwise each id gets its own counter and the limit is per-id, not per-route.
   */
  bucket?: string;
}

// Middleware to rate limit API calls. Uses an atomic conditional-increment
// primitive backed by Mongo `findOneAndUpdate` so concurrent requests can't
// undercount the bucket (the prior implementation used a get-check-set race).
export const rateLimit =
  (options: IRateLimitOptions): RequestHandler =>
  async (req, res, next) => {
    const { limit, windowMs, bucket } = options;

    // Resolve the limit per request when a resolver is supplied (per-tier limits).
    const resolvedLimit = typeof limit === 'function' ? await limit(req) : limit;

    // A non-finite/non-positive limit means "no limit" - skip enforcement
    // entirely (admins/developers, and the local dev server).
    if (!Number.isFinite(resolvedLimit) || resolvedLimit <= 0) return next();

    // Extract pathname from URL, excluding query params to prevent bypass.
    // Next.js API routes don't have req.path (Express-only), so we parse req.url.
    // A caller-supplied `bucket` overrides it for dynamic routes (see option doc).
    const pathname = bucket ?? (req.url?.split('?')[0] || '/unknown');

    // Behind API Gateway + Lambda, `req.ip` resolves to an internal AWS proxy
    // address that varies across warm pools - anonymous buckets would scatter
    // and never fill. `getClientIp` walks the canonical CDN headers
    // (Cloudflare, Akamai, X-Real-IP, X-Forwarded-For, Fly) and falls back to
    // socket addresses, stripping ports and filtering private IPv4.
    const key = req.user?.id ? `rate-limit:${req.user.id}:${pathname}` : `rate-limit:${getClientIp(req)}:${pathname}`;

    const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      key,
      resolvedLimit,
      windowMs
    );

    if (success) return next();

    const timeLeftMs = Math.max(0, expiresAt.getTime() - Date.now());
    const retryAfterSeconds = Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : windowMs) / 1000));
    res.setHeader('Retry-After', retryAfterSeconds);
    return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`));
  };
