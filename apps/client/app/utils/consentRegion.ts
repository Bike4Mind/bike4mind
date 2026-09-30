// Consent signals the marketing site pins to the parent domain, read here so one journey
// across two hosts doesn't ask twice. Producer: lib/consent.ts + middleware.ts in the
// marketing-site repo; same shared-cookie mechanism as attributionCookies.ts, so renaming
// either cookie is a cross-repo change. This app resolves no region of its own - proxy.ts
// runs on every route but gets no viewer-country header, and a second lookup there would
// only produce an answer that can disagree with the one the visitor already got.

export const REGION_COOKIE = 'b4m-region';
export const DECISION_COOKIE = 'b4m-consent-decision';

/** 'eu' means opt-in required before anything non-essential loads. */
export type ConsentRegion = 'eu' | 'row';

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  return document.cookie
    .split('; ')
    .find(c => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

/** Anything but an explicit 'row' means ask: assuming the other way drops trackers on a
 * visitor entitled to refuse them first. */
export function readConsentRegion(): ConsentRegion {
  return readCookie(REGION_COOKIE) === 'row' ? 'row' : 'eu';
}

/** The visitor's decision from the marketing site, or null if they made none. Outranks the
 * region, which is only a default for someone who has never chosen. */
export function readSharedConsent(): 'granted' | 'denied' | null {
  const value = readCookie(DECISION_COOKIE);
  return value === 'granted' || value === 'denied' ? value : null;
}

/** 'unset' means the visitor is in the opt-in region and has not answered yet, here or on
 * the marketing site: nothing non-essential may run until they do. */
export type ConsentState = 'granted' | 'denied' | 'unset';

/**
 * Where this origin publishes the decision it resolved, so a request handler can see it.
 *
 * The underscore name marks it app-owned, like b4m_utm and b4m_app_first_touch; the shared
 * marketing cookies above use hyphens, and the two must never be confused. It exists because
 * the server cannot read localStorage: without it an in-app Accept is invisible to every
 * request handler, and server/analytics/serverConsent.ts would suppress a visitor who plainly
 * consented here. See publishResolvedConsent for what it records and why.
 */
export const APP_DECISION_COOKIE = 'b4m_consent';

/** 90 days: outlives b4m_app_first_touch, the longest-lived thing this gate guards. */
const APP_DECISION_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Publish the resolved decision where the server can read it, or withdraw it when the visitor
 * has no decision to publish.
 *
 * Records what resolveConsent RESOLVED and the page then acted on, not only what was clicked,
 * so the server's answer matches the browser's for every visitor - including one auto-granted
 * by region, who clicks nothing. That is the honest signal to publish: the campaign cookies
 * this gate guards are themselves only written when that same resolution says granted
 * (utmCapture.ts flushUtmCapture), so publishing it keeps the gate and the thing it gates in
 * step instead of letting them disagree.
 *
 * This does NOT freeze an auto-allow, which is what activateConsent's comment warns against.
 * It is a cache of the current resolution, rewritten on every load and cleared the moment the
 * resolution goes back to 'unset' - so a visitor who travels from the auto-allow region into
 * the opt-in one loses it and is asked, exactly as before.
 *
 * SameSite=Lax for the transport reason utmCapture.ts sets out at length: an OAuth signup
 * returns through a top-level cross-site GET from the IdP, and Strict is withheld on precisely
 * that navigation. Under Strict this cookie would be missing on the one request it exists for.
 */
export function publishResolvedConsent(value: ConsentState): void {
  if (typeof document === 'undefined') return;
  if (value === 'unset') {
    document.cookie = `${APP_DECISION_COOKIE}=; path=/; SameSite=Lax; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    return;
  }
  const expires = new Date(Date.now() + APP_DECISION_TTL_SECONDS * 1000).toUTCString();
  document.cookie = `${APP_DECISION_COOKIE}=${value}; path=/; SameSite=Lax; expires=${expires}`;
}

/** Where this origin records the visitor's own decision. */
export const CONSENT_KEY = 'cookie_consent';

/** This origin's stored decision, or null if the visitor has not answered here. */
export function readStoredConsent(): 'granted' | 'denied' | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return raw === 'granted' || raw === 'denied' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The consent state every non-essential feature should gate on, so none of them can drift
 * from the banner's own reading. Precedence matches CookieConsentBanner exactly: this
 * origin's decision, then one made on the marketing site, then the region - which is only a
 * default for a visitor who has made no decision anywhere.
 */
export function resolveConsent(): ConsentState {
  const decision = readStoredConsent() ?? readSharedConsent();
  if (decision !== null) return decision;
  return readConsentRegion() === 'row' ? 'granted' : 'unset';
}
