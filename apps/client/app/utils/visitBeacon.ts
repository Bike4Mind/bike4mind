import { resolveConsent } from './consentRegion';

const VISIT_BEACON_PATH = '/api/analytics/visit';

/** The server keeps at most this much of a landing path; a longer one is cut here too. */
const MAX_LANDING_PATH = 200;

/**
 * Where this visit came from and the page it landed on, for the beacon's body: the referring
 * site's origin (never its path or query, which can carry search terms or tokens) and this
 * page's path. Read at module load, before the router redirects a signed-out landing to /login.
 *
 * Only with consent, the same gate the campaign capture uses (utmCapture.ts): both say how the
 * visitor arrived. Without it the body is empty and the visit records no source, which reads
 * as direct. The server checks both values again, since anyone can post to the beacon.
 */
export function visitLanding(): { referrer?: string; landingPath?: string } {
  if (resolveConsent() !== 'granted') return {};
  let referrer: string | undefined;
  try {
    const url = new URL(document.referrer);
    if (url.protocol === 'https:' || url.protocol === 'http:') referrer = url.origin;
  } catch {
    // No referrer (typed URL, bookmark, a no-referrer policy), or one that is no URL.
  }
  return { ...(referrer && { referrer }), landingPath: window.location.pathname.slice(0, MAX_LANDING_PATH) };
}

/**
 * Tell the server a visit is happening.
 *
 * MUST run at app bootstrap, and MUST run after captureUtmParams(): the beacon request is
 * what the server reads the campaign cookie from, so a campaign captured after the request
 * has already gone is a campaign the visit is not attributed to.
 *
 * Fires once per page load, not per route change - the server counts a visit by the cookie
 * it hands back, so repeating the call inside the SPA would add requests and no visits.
 *
 * Nothing is sent but the cookies the browser attaches, which is why `credentials` matters,
 * and, with consent, the referring site's origin and the landing path (visitLanding). Those
 * go in the body because this is a fetch from the app's own page: its Referer header names
 * that page, not the site the visitor came from. No identifiers, no user. Signed in or not
 * makes no difference here; this counts visits, and the signed-in user is reported by the
 * server on its own.
 */
export function beaconVisit(): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  try {
    void fetch(VISIT_BEACON_PATH, {
      method: 'POST',
      // The cookie is the entire mechanism: without it the server cannot tell a returning
      // browser from a new visit, and every page load would count as one.
      credentials: 'same-origin',
      // Survive the navigation that often follows immediately: an unauthenticated landing
      // is redirected to /login, and a request without keepalive is cancelled when that
      // happens - losing exactly the visits that matter most to an acquisition funnel.
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(visitLanding()),
    }).catch(() => {
      // Best-effort telemetry. A failed beacon costs one uncounted visit and must never
      // surface to the person visiting.
    });
  } catch {
    // Older browsers that reject the keepalive option outright, and any environment where
    // fetch exists but is not callable this early.
  }
}
