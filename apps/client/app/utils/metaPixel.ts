// Meta (Facebook) advertising pixel, consent-deferred.
//
// The mirror of redditPixel.ts, and deliberately so: same eager in-memory queue
// stub (no network), same consent-gated script load (CookieConsentBanner), same
// silent no-op when unconfigured. Change one of these files and check the other.
//
// The stub is Meta's published snippet with the script injection removed:
// fbevents.js adopts an existing `window.fbq`, replays `fbq.queue` through
// `callMethod`, and looks for `window._fbq`. Diverging from that shape loses
// every event queued before consent, silently.
//
// Deliberately no `PageView`: in-app navigation is product usage, not marketing
// traffic (the marketing site owns PageView). This pixel exists to attribute
// conversions to ad clicks, which works because Meta's `_fbp` cookie is scoped
// to the parent domain and so is shared with the marketing site where the ad
// click landed.
//
// Configured via NEXT_PUBLIC_META_PIXEL_ID (production-only, see infra/web.ts);
// unset == every function here no-ops (open-core: no brand/account fallback).
//
// CSP: connect.facebook.net (script-src) and www.facebook.com (img-src +
// connect-src, since fbevents picks either transport for the beacon) must stay
// allow-listed in proxy.ts, or this fails with no visible error.

type FbqFn = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  push?: unknown;
  loaded?: boolean;
  version?: string;
};

declare global {
  interface Window {
    fbq?: FbqFn;
    _fbq?: FbqFn;
  }
}

const PIXEL_SCRIPT_URL = 'https://connect.facebook.net/en_US/fbevents.js';
const PIXEL_SCRIPT_ID = 'meta-pixel';

function ensureQueueStub(pixelId: string): FbqFn {
  if (!window.fbq) {
    const stub: FbqFn = (...args: unknown[]) => {
      if (stub.callMethod) {
        // Meta's snippet writes this as `.apply(n, arguments)`; a method call on
        // `stub` binds the same `this`, which fbevents.js relies on.
        stub.callMethod(...args);
      } else {
        stub.queue?.push(args);
      }
    };
    stub.queue = [];
    stub.loaded = true;
    stub.version = '2.0';
    stub.push = stub;
    window.fbq = stub;
    window._fbq = stub;
    window.fbq('init', pixelId);
  }
  return window.fbq;
}

/** Event metadata Meta accepts alongside a conversion (used by "Subscribe"). */
export interface MetaEventParams {
  /** Order value in the currency's MAJOR unit (29.99, not 2999). */
  value?: number;
  /** ISO 4217, e.g. "USD". */
  currency?: string;
  /**
   * Dedupe key - the same id must be sent if the event is ever retried. Meta
   * takes this in a FOURTH argument (`{ eventID }`) rather than in the
   * parameter object, so it is split back out below.
   */
  eventId?: string;
}

/**
 * Queue a Meta conversion event (use Meta's standard event names -
 * "CompleteRegistration", "Subscribe" - so Events Manager recognizes them;
 * note they differ from Reddit's for the same conversion). Safe to call before
 * the pixel script has loaded, before consent, during SSR, and when the pixel
 * isn't configured - all of those either queue in memory or no-op.
 */
export function trackMetaEvent(eventName: string, params?: MetaEventParams): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!pixelId) return;
  const fbq = ensureQueueStub(pixelId);

  const { eventId, ...eventParams } = params ?? {};
  const args: unknown[] = ['track', eventName];
  // Positional: params are third and options fourth, so an eventId with no
  // value/currency still needs an (empty) params object to sit in front of it.
  if (eventId || Object.keys(eventParams).length > 0) args.push(eventParams);
  if (eventId) args.push({ eventID: eventId });
  fbq(...args);
}

/**
 * Load the real pixel script, flushing anything queued. Call ONLY once the
 * visitor has granted cookie consent. Idempotent.
 */
export function loadMetaPixel(): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
  if (!pixelId) return;
  ensureQueueStub(pixelId);
  if (document.getElementById(PIXEL_SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = PIXEL_SCRIPT_ID;
  script.async = true;
  script.src = PIXEL_SCRIPT_URL;
  document.head.appendChild(script);
}
