// Signup conversion tracking: fires the GA4 `sign_up` event and the Reddit
// `SignUp` conversion once per new account, stamped with acquisition
// attribution so ad-driven signups are measurable end-to-end.
//
// Attribution sources (both first-party cookies on the parent domain):
// - `b4m-first-touch`: written once by the marketing site on the visitor's
//   first-ever landing (90-day, write-once) and shared across subdomains.
//   The producing side of this contract lives in the marketing-site repo.
// - `b4m_utm`: this app's own landing-UTM capture (30-min TTL - see
//   utmCapture.ts), i.e. the campaign that drove *this* session.
//
// Callers are responsible for once-per-signup semantics (the password flow's
// success block runs once; the OAuth flow's isNewUser hash param is cleared
// on read). GA4 consent mode and the deferred Reddit pixel handle consent -
// this function is safe to call regardless of consent state.

import { trackRedditEvent } from './redditPixel';

const FIRST_TOUCH_COOKIE = 'b4m-first-touch';
const UTM_COOKIE = 'b4m_utm';

declare function gtag(...args: unknown[]): void;

function readJsonCookie(name: string): Record<string, unknown> | null {
  const entry = document.cookie.split('; ').find(c => c.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(entry.slice(name.length + 1)));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Fire the signup conversion across all wired channels in one place.
 *
 * @param method How the account was created - 'password' or the OAuth
 *   strategy name (e.g. 'google'). Becomes GA4's standard `method` param.
 */
export function trackSignupConversion(method: string): void {
  if (typeof window === 'undefined') return;

  const firstTouch = readJsonCookie(FIRST_TOUCH_COOKIE);
  const utm = readJsonCookie(UTM_COOKIE);

  if (typeof gtag !== 'undefined') {
    const params: Record<string, string> = { method };
    const stamp = (param: string, value: string | undefined) => {
      if (value) params[param] = value;
    };
    stamp('first_touch_source', stringField(firstTouch, 'source'));
    stamp('first_touch_medium', stringField(firstTouch, 'medium'));
    stamp('first_touch_campaign', stringField(firstTouch, 'campaign'));
    stamp('utm_source_at_signup', stringField(utm, 'source'));
    stamp('utm_medium_at_signup', stringField(utm, 'medium'));
    stamp('utm_campaign_at_signup', stringField(utm, 'campaign'));
    gtag('event', 'sign_up', params);
  }

  trackRedditEvent('SignUp');
}
