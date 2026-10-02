// Consent cookie names, shared by the browser (app/utils/consentRegion.ts, which reads and writes
// them) and the server (server/analytics/serverConsent.ts, which gates signup attribution on
// them). Kept here so neither layer imports the other's module.

// Consent signals the marketing site pins to the parent domain, read here so one journey
// across two hosts doesn't ask twice. Producer: lib/consent.ts + middleware.ts in the
// marketing-site repo; same shared-cookie mechanism as attributionCookies.ts, so renaming
// either cookie is a cross-repo change.
export const REGION_COOKIE = 'b4m-region';
export const DECISION_COOKIE = 'b4m-consent-decision';

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
