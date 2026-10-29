import {
  DEFAULT_WRITE_RATE_LIMIT_MODES,
  DEFAULT_WRITE_RATE_LIMIT_PER_MIN,
  hasDeveloperUserTag,
  type DefaultWriteRateLimitMode,
  type SettingKey,
} from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue, TooManyRequestsError } from '@bike4mind/utils';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import type { NextFunction, Request, Response } from 'express';

/**
 * Default per-user cap on write requests, installed by baseApi on every authenticated route. One
 * counter per user across all routes, so it bounds a signed-in account's total write volume on
 * routes that have no limit of their own. Per-route limits still apply on top.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// ms. Fixed window, the same shape as the per-route limits in server-utils' rateLimit.
const WINDOW_MS = 60_000;
// One shared bucket rather than the request path, so the cap counts all of a user's writes together.
const BUCKET = 'default-write';

const LIMIT_SETTING: SettingKey = 'apiRateLimitDefaultWritePerMin';
const MODE_SETTING: SettingKey = 'apiRateLimitDefaultWriteMode';

/**
 * Used when the settings cannot be read. Log-only, unlike the tier limiter's fail-closed floor:
 * this cap covers every write route, so blocking on a settings outage would break normal use.
 */
const FALLBACK = { mode: 'log' as DefaultWriteRateLimitMode, perMin: DEFAULT_WRITE_RATE_LIMIT_PER_MIN };

// ms. Same short TTL as the tier settings (userRateTier.ts), so an admin's change lands within 15s.
const SETTINGS_CACHE_TTL_MS = 15_000;
let settingsCache: { value: { mode: DefaultWriteRateLimitMode; perMin: number }; expiresAt: number } | undefined;

// User id -> the window (its expiry, ms) already logged for that user.
const loggedWindows = new Map<string, number>();
const LOGGED_WINDOWS_MAX = 10_000;

/** Test-only: drop the in-process settings cache and log throttle between cases. */
export const __resetDefaultWriteLimitCache = (): void => {
  settingsCache = undefined;
  loggedWindows.clear();
};

async function readSettings(): Promise<{ mode: DefaultWriteRateLimitMode; perMin: number }> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value;
  let value = FALLBACK;
  try {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { skipCache: true, names: [LIMIT_SETTING, MODE_SETTING] }
    );
    const mode = getSettingsValue(MODE_SETTING, settings);
    const perMin = getSettingsValue(LIMIT_SETTING, settings);
    value = {
      mode: DEFAULT_WRITE_RATE_LIMIT_MODES.includes(mode as DefaultWriteRateLimitMode)
        ? (mode as DefaultWriteRateLimitMode)
        : FALLBACK.mode,
      perMin: typeof perMin === 'number' && perMin > 0 ? perMin : FALLBACK.perMin,
    };
  } catch {
    // Fall through to FALLBACK; cached below so an outage costs one failed read per TTL, not per request.
  }
  settingsCache = { value, expiresAt: now + SETTINGS_CACHE_TTL_MS };
  return value;
}

/** Runs after auth (baseApi), so `req.user` is the signed-in user, impersonated or OAuth sessions included. */
export async function defaultWriteRateLimit(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (
    SAFE_METHODS.has(req.method.toUpperCase()) ||
    !user ||
    // API-key requests are already metered per key by apiKeyRateLimit.
    req.apiKeyInfo ||
    user.isAdmin ||
    hasDeveloperUserTag(user.tags) ||
    isDevelopment()
  ) {
    return next();
  }

  const { mode, perMin } = await readSettings();
  if (mode === 'off') return next();
  // Already over and logged this window: log mode would let it through anyway, so skip the counter,
  // whose over-limit path costs several Mongo round trips per request.
  if (mode === 'log' && (loggedWindows.get(user.id) ?? 0) > Date.now()) return next();

  let counted: { success: boolean; expiresAt: Date };
  try {
    counted = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `rate-limit:${user.id}:${BUCKET}`,
      perMin,
      WINDOW_MS
    );
  } catch (error) {
    // A soft abuse cap: a counter failure must not fail the user's write, in either mode.
    req.logger.warn('[defaultWriteRateLimit] counter unavailable; allowing the write', { error });
    return next();
  }
  const { success, expiresAt } = counted;
  if (success) return next();

  // One line per user per window per process, so the log-only phase shows who would be limited and
  // where without a flooding account writing a log line per refused request.
  if (loggedWindows.get(user.id) !== expiresAt.getTime()) {
    if (loggedWindows.size >= LOGGED_WINDOWS_MAX) loggedWindows.clear();
    loggedWindows.set(user.id, expiresAt.getTime());
    req.logger.warn('[defaultWriteRateLimit] over the default write limit', {
      userId: user.id,
      // Set during an admin's support session, whose writes count against the user it acts as.
      impersonatedBy: user.impersonatedBy,
      path: req.url?.split('?')[0],
      method: req.method,
      perMin,
      mode,
    });
  }
  if (mode === 'log') return next();

  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  res.setHeader('Retry-After', retryAfterSeconds);
  return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.`));
}
