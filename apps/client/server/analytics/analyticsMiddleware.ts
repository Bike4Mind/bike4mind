import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { OverwatchUtm } from '@bike4mind/common';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { isAnalyticsConfigured, emitActiveEvent, sanitizeReferrer } from './emitActiveEvent';
import { pseudonymizeUserId } from './pseudonymize';
import { resolveUserType } from './resolveUserType';

function utcDate(): string {
  return new Date().toISOString().substring(0, 10);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    try {
      result[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      // malformed percent-encoding - skip pair
    }
  }
  return result;
}

function readUtmCookie(req: Request): OverwatchUtm | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies['b4m_utm'];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const utm: OverwatchUtm = {};
    if (typeof parsed.source === 'string') utm.source = parsed.source.substring(0, 128);
    if (typeof parsed.medium === 'string') utm.medium = parsed.medium.substring(0, 128);
    if (typeof parsed.campaign === 'string') utm.campaign = parsed.campaign.substring(0, 128);
    if (typeof parsed.content === 'string') utm.content = parsed.content.substring(0, 128);
    return Object.keys(utm).length > 0 ? utm : undefined;
  } catch {
    return undefined;
  }
}

// In-memory throttle shared across ALL analyticsMiddleware() instances in a Lambda container.
// baseApi() is invoked at module scope in every pages/api route file (~600 of them), so a
// factory-local map would be per-route - a user hitting N routes/day would emit N times. A
// module-level map is the true per-instance store. Best-effort only: correctness lives in
// OverwatchUserDay's (productId, date, userId) idempotent upsert. Keyed pseudoUserId -> UTC-day:
// a returning user's entry is overwritten with the current day, but an entry for a user seen
// once and never again is NOT purged until the Lambda recycles. So the map is bounded by
// "distinct users seen on this instance over its lifetime", not by DAU. That's acceptable at
// b4m scale (traffic spreads across short-lived instances); revisit with a size-thresholded
// purge of stale-day entries only if a single warm instance is ever shown to accumulate a
// pathologically wide user tail.
const emitted = new Map<string, string>();

// Test-only: clear the shared throttle between cases. Not referenced in production code.
export function __resetAnalyticsThrottle(): void {
  emitted.clear();
}

export function analyticsMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Gate: human JWT session only - skip API-key callers and system accounts
    if (!req.user || isApiKeyAuth(req) || req.user.isSystem === true) {
      next();
      return;
    }

    if (!isAnalyticsConfigured()) {
      next();
      return;
    }

    const today = utcDate();
    const pseudoUserId = pseudonymizeUserId(req.user.id);

    if (emitted.get(pseudoUserId) === today) {
      next();
      return;
    }
    emitted.set(pseudoUserId, today);

    // Deterministic sessionId: forensic-only; downstream never groups on it
    const sessionId = crypto.createHash('sha256').update(`${pseudoUserId}:${today}`).digest('hex');

    const userType = resolveUserType({ level: req.user.level, subscribedUntil: req.user.subscribedUntil });
    const utm = readUtmCookie(req);
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
    const referrer = sanitizeReferrer(referer);

    // Fire-and-forget - intentionally NOT awaited. Awaiting before next() would add up to the
    // 2s emit timeout to the first-request-of-day latency for every user. We accept that a Lambda
    // freeze may drop or delay a fraction of emits; OverwatchUserDay's idempotent upsert plus the
    // daily cadence absorb that loss.
    void emitActiveEvent({ pseudoUserId, sessionId, userType, referrer, utm }).catch(() => {});

    next();
  };
}
