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

/** 'unset' means the visitor is in the opt-in region and has not answered yet, here or on
 * the marketing site: nothing non-essential may run until they do. */
export type ConsentState = 'granted' | 'denied' | 'unset';

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
