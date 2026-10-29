import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue, TooManyRequestsError } from '@bike4mind/utils';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { isValidE2eTestSecret } from '@server/auth/e2eTestSecret';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { ipBucket } from '@bike4mind/server-utils/utils/ipBucket';
import type { RequestHandler } from 'express';

/**
 * Fixed-window per-IP cap on OAuth initiation and callback, sized by admin settings. Initiation and
 * callback count separately so a normal sign-in (one of each) spends one unit of each. Deliberately
 * per IP and never global: a global cap would let an attacker exhaust it and refuse real sign-ups.
 */
export const oauthIpRateLimit =
  (bucket: 'oauth-init' | 'oauth-callback'): RequestHandler =>
  async (req, res, next) => {
    // CI draws every sign-in from one shared IP. Gated on the secret header, not just the stage, so
    // previews (E2E-enabled for everyone) still enforce the limit on real traffic.
    if (isE2EEnabled() && isValidE2eTestSecret(req.headers['x-e2e-cleanup-secret'])) return next();

    let windowMs: number;
    let result: { success: boolean; expiresAt: Date };
    try {
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      const limit = getSettingsValue('oauthRateLimitPerIp', settings, 40);
      windowMs = getSettingsValue('oauthRateLimitWindowMinutes', settings, 10) * 60_000;
      result = await cacheRepository.tryIncrementWithinLimitFixedWindow(
        `oauth-limit:${bucket}:${ipBucket(getClientIp(req))}`,
        limit,
        windowMs
      );
    } catch (error) {
      // Fail open like checkBlockedIP: a cache or settings outage must not turn sign-in into a 500.
      req.logger?.warn('Failed to check OAuth rate limit, allowing request to continue', error);
      return next();
    }
    const { success, expiresAt } = result;
    if (success) return next();

    req.logger?.warn('oauth-ip-rate-limited', { bucket });

    const timeLeftMs = expiresAt.getTime() - Date.now();
    const seconds = Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : windowMs) / 1000));
    res.setHeader('Retry-After', seconds);

    // Same navigation/JSON split as checkBlockedIP: a browser mid sign-in gets the login page.
    const path = req.path || (req.url ? req.url.split('?')[0] : '');
    if (path.startsWith('/api/') && req.headers.accept?.includes('application/json')) {
      return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${seconds} seconds.`));
    }
    return res.redirect('/login?error=oauth_rate_limited');
  };
