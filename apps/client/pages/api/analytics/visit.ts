import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { isDevelopment } from '@bike4mind/server-utils/utils/config';
import { isAnalyticsConfigured, emitVisitEvent } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { readUtmCookie } from '@bike4mind/server-utils/analytics/cookies';
import {
  isProbableBot,
  mintVisitId,
  readVisitId,
  readVisitPending,
  visitCookieHeader,
  visitPendingCookieHeader,
} from '@server/analytics/visitSession';
import { readVisitLanding } from '@server/analytics/visitLanding';

/**
 * POST /api/analytics/visit - the visit beacon.
 *
 * Why this exists at all: analyticsMiddleware() is installed only inside baseApi's
 * authenticated branch, so it never sees an anonymous request - not merely because of its
 * own `!req.user` gate, but because it is not mounted on unauthenticated routes and JWT
 * auth rejects an anonymous caller before the chain reaches it. Anonymous traffic is the
 * first stage of an acquisition funnel, and nothing was in a position to observe it.
 *
 * So the app's bootstrap calls this on every page load, signed in or not. The cookie does
 * the counting: a request with no visit cookie is the start of a visit and emits exactly
 * one event; a request that already carries one emits nothing and only slides the
 * inactivity window forward. One event per visit, by construction rather than by throttle.
 *
 * One exception to "emits at the start": a visitor still being asked for consent can't send a
 * source yet, and a visit's source is read from its one event alone. So a beacon awaiting
 * consent starts the visit and holds its event, marked by the pending cookie, and the beacon
 * the browser sends once the visitor answers (or leaves without answering) emits it
 * (visitBeacon.ts releaseVisitBeacon).
 *
 * Unauthenticated deliberately, and correspondingly narrow: its body is at most a referrer
 * origin and a landing path (or the awaiting-consent flag), it returns no body, writes the visit
 * cookie (and, while the event is held, the pending mark), and the only thing it records is a
 * server-minted id, those two (checked: visitLanding.ts) and the campaign cookie.
 * There is nothing here to act on behalf of a user, which is why it needs neither auth nor CSRF
 * protection; what it does need is a bound on volume, since it is a public path that writes.
 * Hence the per-IP rate limit below, on top of the `/api/` per-IP counter the edge WAF already
 * keeps.
 *
 * The referrer comes from the body, never the Referer header: the beacon is a fetch from the
 * app's own page, so the header always names that page, and a visit read from it came from the
 * app itself. A body without one (consent declined or never given, no referrer, or a page loaded
 * before this shipped) records none, which reads as direct.
 */

// Per-IP, and generous against real use: a page load fires this once, so a browser needs
// 60 loads in a minute to reach it. It is aimed at the case the bot heuristic cannot catch -
// an agent that presents a browser user-agent and keeps no cookies, which would otherwise
// mint a fresh visit on every request.
const VISIT_BEACON_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000, bucket: 'analytics-visit' } as const;

/** The beacon a visitor sends while still being asked for consent (visitBeacon.ts). */
function isAwaitingConsent(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as Record<string, unknown>).awaitingConsent === true;
}

const handler = baseApi({ auth: false, maxBodySize: 1024 })
  .use(rateLimit(VISIT_BEACON_RATE_LIMIT))
  .post(async (req, res) => {
    // Never let a CDN or API Gateway cache this: the response carries a Set-Cookie, and a
    // cached one would hand a single visit id to every visitor behind that cache - every
    // subsequent visit collapsing into one session.
    res.setHeader('Cache-Control', 'no-store');

    if (!isAnalyticsConfigured()) return res.status(204).end();

    // No cookie for a non-human agent either: giving one out would make the next request
    // from it look like a returning visit rather than a filtered one.
    if (isProbableBot(req.headers['user-agent'])) return res.status(204).end();

    const existing = readVisitId(req.headers.cookie);
    const visitId = existing ?? mintVisitId();
    const secure = !isDevelopment();

    const markedPending = readVisitPending(req.headers.cookie);
    const unrecorded = existing === undefined || markedPending;
    const hold = unrecorded && isAwaitingConsent(req.body);

    // Sent on every call, not only when minting - this is what keeps an active browser on
    // one visit instead of starting a new one every 30 minutes. The pending mark slides with
    // it while the event is held, and is expired once it is not.
    const cookies = [visitCookieHeader(visitId, { secure })];
    if (hold || markedPending) cookies.push(visitPendingCookieHeader(hold, { secure }));
    res.setHeader('Set-Cookie', cookies);

    if (!unrecorded || hold) return res.status(204).end();

    const landing = readVisitLanding(req.body);

    // Fire-and-forget, like the middleware's emit: a page load must not wait on the ingest
    // hop, and a dropped visit event costs one session in a count that is already
    // best-effort. Errors are swallowed inside emitVisitEvent.
    void emitVisitEvent({
      sessionId: visitId,
      referrer: landing.referrer,
      utm: readUtmCookie(req),
      landingPath: landing.landingPath,
    }).catch(() => {});

    return res.status(204).end();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
