import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { signOutputUrl } from './signOutputUrl';

export const mapperDeps = { sign: signOutputUrl, now: () => new Date() };

export const perUserRateLimit = (bucket: string) =>
  rateLimit({ limit: req => resolveUserRateLimitPerMin(req.user), windowMs: 60 * 1000, bucket });
