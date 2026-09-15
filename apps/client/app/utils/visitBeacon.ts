const VISIT_BEACON_PATH = '/api/analytics/visit';

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
 * Nothing is sent but the request itself: no body, no identifiers, no user. The whole
 * payload is the cookies the browser attaches, which is why `credentials` matters. Signed
 * in or not makes no difference here; this counts visits, and the signed-in user is
 * reported by the server on its own.
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
    }).catch(() => {
      // Best-effort telemetry. A failed beacon costs one uncounted visit and must never
      // surface to the person visiting.
    });
  } catch {
    // Older browsers that reject the keepalive option outright, and any environment where
    // fetch exists but is not callable this early.
  }
}
