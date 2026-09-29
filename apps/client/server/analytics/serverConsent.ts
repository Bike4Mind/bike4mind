import type { Request } from 'express';
import { parseCookies } from './cookies';

/**
 * The marketing site's cross-host decision cookie. Written by lib/consent.ts in that repo
 * (`publishConsentDecision`) on the parent domain, which is why this app can read it at all.
 * The name is duplicated in app/utils/consentRegion.ts for the browser side; a rename is a
 * three-place change across two repos.
 */
export const DECISION_COOKIE = 'b4m-consent-decision';

/**
 * Whether this request may have campaign attribution read off it, decided server-side.
 *
 * Fail closed: only an explicit `granted` permits. Denied, absent, malformed, or any value we
 * do not recognise all suppress. This is deliberately stricter than the browser's
 * `resolveConsent()`, which also treats the `row` region as an implicit grant - the server
 * cannot see this origin's localStorage decision, so the region rule alone would have it
 * inferring a grant from a cookie the visitor never answered.
 *
 * The cost of that strictness is real and worth stating: the marketing site publishes the
 * decision cookie only when a visitor actually decides (or has decided before), so a `row`
 * visitor who never opened the banner carries no cookie and is suppressed here even though the
 * browser auto-granted and wrote the campaign cookies. Those signups go unattributed. That is
 * the safe direction to be wrong in for a consent gate, but it does mean this path emits far
 * less than the cookie jar alone would suggest.
 *
 * Deliberately NOT the same shape as checkout, which trusts an `attributionConsent` boolean the
 * client computed. A top-level OAuth callback is a GET with no body to carry such a flag, so the
 * decision has to be re-read here.
 */
export function resolveServerConsent(req: Pick<Request, 'headers'>): 'granted' | 'suppressed' {
  const decision = parseCookies(req.headers.cookie)[DECISION_COOKIE];
  return decision === 'granted' ? 'granted' : 'suppressed';
}
