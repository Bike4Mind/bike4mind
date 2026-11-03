import { resolveConsent } from './consentRegion';
import { capPagePath, visitBeaconLanding, visitBeaconSettled } from './visitBeacon';

const PAGE_BEACON_PATH = '/api/analytics/page';

/** A runaway guard, per page load: a redirect loop or a script driving the router stops here. */
const MAX_PAGE_BEACONS = 100;

let started = false;
/**
 * The last page this beacon sent in this page load. Until it sends one, the last page the server
 * has from this load is the one the visit beacon carried, if it carried one.
 */
let lastSent: string | undefined;
let sentCount = 0;

/**
 * Start this page load's page beacon. MUST run at bootstrap after beaconVisit(): a page sent
 * before the visit beacon could be the landing that beacon is about to carry, and count twice.
 */
export function startPageBeacon(): void {
  if (typeof window === 'undefined') return;
  started = true;
  lastSent = undefined;
  sentCount = 0;
}

/**
 * Tell the server the visitor is on another page of their visit, so every page of a visit after
 * its landing, and the page it ended on, are known. A page reached by a full page load is
 * reported by the visit beacon instead (visitBeacon.ts), which carries it as its landing path.
 *
 * Called each time the router settles on a page (router.tsx), and when the visitor answers the
 * consent banner (CookieConsentBanner.tsx), so the page they were on while being asked is recorded
 * once they grant: often the login a signed-out landing was redirected to, or the landing itself
 * when the visit beacon went out without it (consent declined at load, or the page hidden before
 * an answer). Sends only with consent: nothing while it is declined or not yet given, and nothing
 * is held for later.
 *
 * The body is the path alone, cut like the landing (capPagePath); the server cleans it again and
 * records it only on a visit the visit beacon has recorded. Nothing is sent when the path is the
 * one the server last had from this page load, which covers a landing the visit beacon carried,
 * query- and hash-only changes and a repeat.
 */
export function beaconPage(): void {
  if (!started || typeof fetch !== 'function') return;
  if (resolveConsent() !== 'granted') return;
  const path = capPagePath(window.location.pathname);
  // Empty when one segment runs past the cap; the server records no such path, so nothing is sent.
  if (path === '' || path === (lastSent ?? visitBeaconLanding()) || sentCount >= MAX_PAGE_BEACONS) return;
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
