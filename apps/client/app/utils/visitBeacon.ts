import { resolveConsent } from './consentRegion';

const VISIT_BEACON_PATH = '/api/analytics/visit';

/** The server keeps at most this much of a page path; a longer one is cut here too. */
const MAX_PAGE_PATH = 200;

/**
 * A page path cut to the server's cap at a `/`: a token cut mid-way arrives too short for the
 * server to recognise and redact. The page beacon (pageBeacon.ts) cuts the same way.
 */
export function capPagePath(path: string): string {
  return path.length > MAX_PAGE_PATH ? path.slice(0, path.lastIndexOf('/', MAX_PAGE_PATH)) : path;
}

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
  return { ...(referrer && { referrer }), landingPath: capPagePath(window.location.pathname) };
}

let lastRequest: Promise<unknown> = Promise.resolve();
let sentLanding: string | undefined;

/**
 * Settles, never rejects, once the latest visit beacon request has. The page beacon waits on it
 * (pageBeacon.ts), so its request carries the visit cookie that response set and finds the visit
 * recorded rather than still held for consent.
 */
export function visitBeaconSettled(): Promise<unknown> {
  return lastRequest;
}

/**
 * The page this load's latest visit beacon request carried, for the server to record (as the
 * visit's landing, or as a page_view on a later load) if the request reaches it; undefined while
 * held or when sent without consent. The page beacon (pageBeacon.ts) sends the landing itself only when this is not it.
 */
export function visitBeaconLanding(): string | undefined {
  return sentLanding;
}

function send(body: VisitLanding | { awaitingConsent: true }): void {
  try {
    lastRequest = fetch(VISIT_BEACON_PATH, {
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
    sentLanding = 'landingPath' in body ? body.landingPath : undefined;
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
 * it hands back, so repeating the call inside the SPA would add requests and no visits. On a
 * later page load of a visit, the landing path it sends is recorded as one of the visit's pages;
 * the pages the app moves to without a load are reported by the page beacon (pageBeacon.ts).
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
 * the tab finds the visit already recorded without a source. A grant then still records the
 * page the visitor is on, through the page beacon (pageBeacon.ts).
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
