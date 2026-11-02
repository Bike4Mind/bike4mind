import { resolveConsent } from './consentRegion';
import { capPagePath, visitBeaconSettled } from './visitBeacon';

const PAGE_BEACON_PATH = '/api/analytics/page';

/** A runaway guard, per page load: a redirect loop or a script driving the router stops here. */
const MAX_PAGE_BEACONS = 100;

/** The last path the server has from this page load: the landing (on the visit), then each page sent. */
let lastSent: string | undefined;
let sentCount = 0;

/**
 * Note the page this load landed on, which the visit beacon already reports, so it is not sent
 * again. MUST run at bootstrap beside beaconVisit(), before the router's first resolve can
 * redirect a signed-out landing: the page it redirects to is a later page.
 */
export function startPageBeacon(): void {
  if (typeof window === 'undefined') return;
  lastSent = capPagePath(window.location.pathname);
  sentCount = 0;
}

/**
 * Tell the server the visitor is on another page of their visit, so a visit's later pages, and
 * the page it ended on, are known.
 *
 * Called each time the router settles on a page (router.tsx), and when the visitor answers the
 * consent banner (CookieConsentBanner.tsx), so the page they were on while being asked, often the
 * login a signed-out landing was redirected to, is recorded once they grant. Sends only with
 * consent: nothing while it is declined or not yet given, and nothing is held for later.
 *
 * The body is the path alone, cut like the landing (capPagePath); the server cleans it again and
 * records it only on a visit the visit beacon has recorded. Nothing is sent when the path is the
 * one the server last had, which covers the landing itself, query- and hash-only changes and a
 * repeat.
 */
export function beaconPage(): void {
  if (lastSent === undefined || typeof fetch !== 'function') return;
  if (resolveConsent() !== 'granted') return;
  const path = capPagePath(window.location.pathname);
  if (path === lastSent || sentCount >= MAX_PAGE_BEACONS) return;
  lastSent = path;
  sentCount += 1;
  // After the visit beacon's response: on a first visit the router's redirect, or a grant's
  // release, would otherwise race it and arrive without the visit cookie, or with the visit
  // still held, and be dropped.
  void visitBeaconSettled()
    .then(() =>
      fetch(PAGE_BEACON_PATH, {
        method: 'POST',
        // The visit cookie is what ties the page to its visit; without it nothing is recorded.
        credentials: 'same-origin',
        // A click away from the app often follows at once, and would cancel a plain request.
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
    )
    .catch(() => {
      // Best-effort telemetry, as the visit beacon: a lost page must never surface to the visitor,
      // and a browser that rejects keepalive outright lands here too.
    });
}
