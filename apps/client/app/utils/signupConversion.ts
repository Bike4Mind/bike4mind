// Signup conversion tracking: fires the GA4 `sign_up` event and the Reddit
// `SignUp` conversion once per new account, stamped with acquisition
// attribution so ad-driven signups are measurable end-to-end.
//
// Attribution comes from the shared first-party cookies - see
// attributionCookies.ts for that contract. The paid counterpart to this file is
// purchaseConversion.ts, which reports revenue at first charge.
//
// Callers are responsible for once-per-signup semantics (the password flow's
// success block runs once; the OAuth flow's isNewUser hash param is cleared
// on read). GA4 consent mode and the deferred Reddit pixel handle consent -
// this function is safe to call regardless of consent state.

import { attributionParams } from './attributionCookies';
import { trackRedditEvent } from './redditPixel';

declare function gtag(...args: unknown[]): void;

/**
 * Fire the signup conversion across all wired channels in one place.
 *
 * @param method How the account was created - 'password' or the OAuth
 *   strategy name (e.g. 'google'). Becomes GA4's standard `method` param.
 */
export function trackSignupConversion(method: string): void {
  if (typeof window === 'undefined') return;

  if (typeof gtag !== 'undefined') {
    gtag('event', 'sign_up', { method, ...attributionParams('signup') });
  }

  trackRedditEvent('SignUp');
}
