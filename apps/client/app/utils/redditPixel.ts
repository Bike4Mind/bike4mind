// Reddit advertising pixel, consent-deferred.
//
// The queue stub (`window.rdt`) is installed eagerly and cheaply - it holds
// events in memory and makes NO network requests. The actual pixel script
// (which phones home) loads only after the visitor grants cookie consent
// (CookieConsentBanner), at which point queued calls - the init plus any
// conversion fired while the banner was still open - flush to Reddit. A
// visitor who declines never loads the script and nothing is sent.
//
// Deliberately no `PageVisit` tracking: in-app navigation is product usage,
// not marketing traffic (the marketing site owns PageVisit). This pixel
// exists to attribute conversion events (signup) to ad clicks, which works
// because Reddit's `_rdt_uuid` cookie is scoped to the parent domain and so
// is shared between the marketing site (where the ad click landed) and here.
//
// Configured via NEXT_PUBLIC_REDDIT_PIXEL_ID (production-only, see
// infra/web.ts); unset == every function here no-ops (open-core: no
// brand/account fallback).

type RdtFn = ((...args: unknown[]) => void) & {
  callQueue?: unknown[];
  sendEvent?: (...args: unknown[]) => void;
};

declare global {
  interface Window {
    rdt?: RdtFn;
  }
}

const PIXEL_SCRIPT_URL = 'https://www.redditstatic.com/ads/pixel.js';
const PIXEL_SCRIPT_ID = 'reddit-pixel';

function ensureQueueStub(pixelId: string): RdtFn {
  if (!window.rdt) {
    const stub: RdtFn = (...args: unknown[]) => {
      if (stub.sendEvent) {
        stub.sendEvent(...args);
      } else {
        stub.callQueue?.push(args);
      }
    };
    stub.callQueue = [];
    window.rdt = stub;
    window.rdt('init', pixelId);
  }
  return window.rdt;
}

/**
 * Queue a Reddit conversion event (e.g. "SignUp" - use Reddit's standard
 * event names so Events Manager recognizes them). Safe to call before the
 * pixel script has loaded, before consent, during SSR, and when the pixel
 * isn't configured - all of those either queue in memory or no-op.
 */
export function trackRedditEvent(eventName: string): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID;
  if (!pixelId) return;
  ensureQueueStub(pixelId)('track', eventName);
}

/**
 * Load the real pixel script, flushing anything queued. Call ONLY once the
 * visitor has granted cookie consent. Idempotent.
 */
export function loadRedditPixel(): void {
  if (typeof window === 'undefined') return;
  const pixelId = process.env.NEXT_PUBLIC_REDDIT_PIXEL_ID;
  if (!pixelId) return;
  ensureQueueStub(pixelId);
  if (document.getElementById(PIXEL_SCRIPT_ID)) return;
  const script = document.createElement('script');
  script.id = PIXEL_SCRIPT_ID;
  script.async = true;
  script.src = PIXEL_SCRIPT_URL;
  document.head.appendChild(script);
}
