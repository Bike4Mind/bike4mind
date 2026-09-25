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
