import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { isAnalyticsConfigured, emitPageViewEvent } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { isProbableBot, readVisitId, readVisitPending } from '@server/analytics/visitSession';
import { cleanLandingPath } from '@server/analytics/visitLanding';

/**
 * POST /api/analytics/page - the page beacon (app/utils/pageBeacon.ts).
 *
 * The visit beacon (visit.ts) runs on every page load but records a visit, and the page it landed
 * on, only on the visit's first. The app then changes page without loading one, so the browser
 * reports each later page here, and a visit's later pages, and the page it ended on, are known.
 *
 * It only ever adds to a visit the visit beacon has recorded: the request must carry a visit
 * cookie and no pending mark. No visit, a visit still held for the visitor's consent answer, or a
 * bot records nothing. It never mints a visit and never sets or slides a cookie, so a visit still
 * ends 30 minutes after its last page load (visitSession.ts), the lifetime the visit beacon gives
 * it; a page change here is not a page load, and refreshing the cookie from it would keep a visit
 * alive for as long as the tab is used. A page sent after the cookie has expired is dropped.
 *
 * Unauthenticated for the visit beacon's reasons, and narrower: the body is one path, checked by
 * the same cleaner as the landing (visitLanding.ts), and all it records is that path on a visit
 * id this server minted. Its own per-IP bucket, so a burst of page changes can never use up the
 * allowance the visit beacon counts visits with.
 */

// Per-IP. A person clicking quickly through the app changes page a few times a minute; 120
// leaves room for bursts and for several people behind one address, and the browser stops
// itself after 100 a page load (pageBeacon.ts).
const PAGE_BEACON_RATE_LIMIT = { limit: 120, windowMs: 60 * 1000, bucket: 'analytics-page' } as const;

function bodyPath(body: unknown): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>).path : undefined;
}

const handler = baseApi({ auth: false, maxBodySize: 1024 })
  .use(rateLimit(PAGE_BEACON_RATE_LIMIT))
  .post(async (req, res) => {
    // A cache that answered in the server's place would drop every page behind it.
    res.setHeader('Cache-Control', 'no-store');

    if (!isAnalyticsConfigured()) return res.status(204).end();
    if (isProbableBot(req.headers['user-agent'])) return res.status(204).end();

    const visitId = readVisitId(req.headers.cookie);
    if (visitId === undefined || readVisitPending(req.headers.cookie)) return res.status(204).end();

    // Anyone can post here, so the path is cleaned again: secret-shaped segments become
    // `:token`, and a path holding an address, or not a path at all, records nothing.
    const path = cleanLandingPath(bodyPath(req.body));
    if (path === undefined) return res.status(204).end();

    // Fire-and-forget, as the visit emit: errors are swallowed inside emitPageViewEvent.
    void emitPageViewEvent({ sessionId: visitId, path }).catch(() => {});

    return res.status(204).end();
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
