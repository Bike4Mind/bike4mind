import type { Request, Response, NextFunction } from 'express';
import { OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { isAnalyticsConfigured, emitActiveEvent, sanitizeReferrer } from './emitActiveEvent';
import { readUtmCookie } from './cookies';
import { readVisitId } from './visitSession';
import { pseudonymizeUserId } from './pseudonymize';
import { resolveUserType } from './resolveUserType';

function utcDate(): string {
  return new Date().toISOString().substring(0, 10);
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

    // The visit this request belongs to, as the visit cookie reports it - the same value
    // the visit beacon sends, so an active event and the visit it happened during are one
    // session downstream rather than two.
    //
    // This value IS grouped on: a consumer of OverwatchRawEvent counts distinct sessionIds
    // per product as the first stage of an acquisition funnel. It used to be
    // sha256(pseudoUserId : UTC-date), which is stable for a whole day by construction, so
    // that count was a count of authenticated user-days wearing the name "sessions" - not
    // comparable with a product that sends a real per-visit id, and not a funnel stage.
    //
    // When no cookie is present there is no visit to name, and the sentinel says so rather
    // than inventing one. A request reaches here without one when it did not come from a
    // browser running this app: a JWT-bearing script, a mobile client, a curl. Inventing a
    // per-request id for those would add a phantom session per request to the funnel; the
    // sentinel adds one bucket a consumer can exclude outright. The user is still counted
    // in DAU either way, which is what this emit is for.
    const sessionId = readVisitId(req.headers.cookie) ?? OVERWATCH_UNKNOWN_SESSION_ID;

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
