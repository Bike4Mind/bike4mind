import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { isDevelopment } from '@server/utils/config';
import { isAnalyticsConfigured, emitVisitEvent, sanitizeReferrer } from '@server/analytics/emitActiveEvent';
import { readUtmCookie } from '@server/analytics/cookies';
import { isProbableBot, mintVisitId, readVisitId, visitCookieHeader } from '@server/analytics/visitSession';

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
 * Unauthenticated deliberately, and correspondingly narrow: it takes no body, returns no
 * body, writes one cookie, and the only thing it records is a server-minted id, the
 * referrer and the campaign cookie. There is nothing here to act on behalf of a user, which
 * is why it needs neither auth nor CSRF protection; what it does need is a bound on volume,
 * since it is a public path that writes. Hence the per-IP rate limit below, on top of the
 * `/api/` per-IP counter the edge WAF already keeps.
 */

// Per-IP, and generous against real use: a page load fires this once, so a browser needs
// 60 loads in a minute to reach it. It is aimed at the case the bot heuristic cannot catch -
// an agent that presents a browser user-agent and keeps no cookies, which would otherwise
// mint a fresh visit on every request.
const VISIT_BEACON_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000, bucket: 'analytics-visit' } as const;

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

    // Sent on every call, not only when minting - this is what keeps an active browser on
    // one visit instead of starting a new one every 30 minutes.
    res.setHeader('Set-Cookie', visitCookieHeader(visitId, { secure: !isDevelopment() }));

    if (existing !== undefined) return res.status(204).end();

    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;

    // Fire-and-forget, like the middleware's emit: a page load must not wait on the ingest
    // hop, and a dropped visit event costs one session in a count that is already
    // best-effort. Errors are swallowed inside emitVisitEvent.
    void emitVisitEvent({
      sessionId: visitId,
      referrer: sanitizeReferrer(referer),
      utm: readUtmCookie(req),
    }).catch(() => {});

    return res.status(204).end();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
