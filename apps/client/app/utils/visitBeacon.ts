import { resolveConsent } from './consentRegion';

const VISIT_BEACON_PATH = '/api/analytics/visit';

/** The server keeps at most this much of a landing path; a longer one is cut here too. */
const MAX_LANDING_PATH = 200;

type VisitLanding = { referrer?: string; landingPath?: string };

/**
 * Where this visit came from and the page it landed on: the referring site's origin (never its
 * path or query, which can carry search terms or tokens) and this page's path. Read when the
 * beacon fires at bootstrap, before the router redirects a signed-out landing to /login.
 *
 * Sent only with consent, the same gate the campaign capture uses (utmCapture.ts): both say how
 * the visitor arrived. The server checks both values again, since anyone can post to the beacon.
 */
function visitLanding(): VisitLanding {
  let referrer: string | undefined;
  try {
    const url = new URL(document.referrer);
    if (url.protocol === 'https:' || url.protocol === 'http:') referrer = url.origin;
  } catch {
    // No referrer (typed URL, bookmark, a no-referrer policy), or one that is no URL.
  }
  const path = window.location.pathname;
  // Cut at a `/`: a token cut mid-way arrives too short for the server to recognise and redact.
  const landingPath = path.length > MAX_LANDING_PATH ? path.slice(0, path.lastIndexOf('/', MAX_LANDING_PATH)) : path;
  return { ...(referrer && { referrer }), landingPath };
}

function send(body: VisitLanding | { awaitingConsent: true }): void {
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
      body: JSON.stringify(body),
    }).catch(() => {
      // Best-effort telemetry. A failed beacon costs one uncounted visit and must never
      // surface to the person visiting.
    });
  } catch {
    // Older browsers that reject the keepalive option outright, and any environment where
    // fetch exists but is not callable this early.
  }
}

/** The landing held back while the visitor is asked for consent; null when no beacon waits. */
let held: VisitLanding | null = null;

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
 *
 * A visitor still being asked for consent has no answer yet to send a source under, and the
 * first visit from search or a shared link usually lands on the banner. So the beacon holds
 * the landing and says the visit is awaiting consent, and the server holds the visit's event
 * until releaseVisitBeacon() follows with the answer.
 */
export function beaconVisit(): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return;
  const consent = resolveConsent();
  if (consent === 'unset') {
    held = visitLanding();
    window.addEventListener('pagehide', releaseVisitBeacon);
    document.addEventListener('visibilitychange', releaseWhenHidden);
    send({ awaitingConsent: true });
    return;
  }
  send(consent === 'granted' ? visitLanding() : {});
}

/**
 * Record the visit this page's beacon left awaiting consent: with the held landing if consent
 * is now granted, with no source otherwise. No-op unless a beacon is waiting.
 *
 * Called by CookieConsentBanner when the visitor answers, after flushUtmCapture(): this
 * request is the one the server reads the campaign cookie from, as for beaconVisit(). Also
 * runs when the page is hidden or unloaded first, so a visitor who never answers is still
 * counted. Hidden rather than only unloaded because mobile browsers often discard a
 * backgrounded tab without a pagehide; the cost is that an answer given after returning to
 * the tab finds the visit already recorded without a source.
 */
export function releaseVisitBeacon(): void {
  if (held === null) return;
  const landing = resolveConsent() === 'granted' ? held : {};
  held = null;
  window.removeEventListener('pagehide', releaseVisitBeacon);
  document.removeEventListener('visibilitychange', releaseWhenHidden);
  send(landing);
}

function releaseWhenHidden(): void {
  if (document.visibilityState === 'hidden') releaseVisitBeacon();
}
