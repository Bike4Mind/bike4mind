import type { Request } from 'express';
import { APP_DECISION_COOKIE, DECISION_COOKIE } from '@client/lib/consentCookies';
import { parseCookies } from './cookies';

/**
 * Whether this request may have campaign attribution read off it, decided server-side.
 *
 * Reads this origin's published decision (APP_DECISION_COOKIE) first, then the marketing site's
 * shared one. The app cookie is what makes an in-app Accept visible here at all - the decision
 * itself lives in localStorage, which a request handler cannot see - and reading it first is what
 * stops an in-app decline being overridden by a shared grant.
 *
 * This approximates resolveConsent rather than re-running it. The app cookie is a snapshot of the
 * browser's resolution (stored decision, shared decision, region) as of the last app page load,
 * and it wins unconditionally: a shared `denied` made on the marketing site after that load does
 * not shadow an app `granted` until the app loads again and republishes. The region is never
 * read here; it reaches the server only through that snapshot.
 *
 * Fail closed. Only an explicit `granted` permits; denied, absent, empty, malformed and
 * unrecognised all suppress, at both levels. A value we do not recognise is not a decision, so
 * it falls through to the next source rather than being read as a denial - again matching
 * resolveConsent, where readStoredConsent returns null for anything but the two known values.
 *
 * Deliberately NOT the same shape as checkout, which trusts an `attributionConsent` boolean the
 * client computed. A top-level OAuth callback is a GET with no body to carry such a flag, so the
 * decision has to be re-read here.
 */
export function resolveServerConsent(req: Pick<Request, 'headers'>): 'granted' | 'suppressed' {
  const cookies = parseCookies(req.headers.cookie);
  const decide = (v: string | undefined) => (v === 'granted' || v === 'denied' ? v : undefined);
  const decision = decide(cookies[APP_DECISION_COOKIE]) ?? decide(cookies[DECISION_COOKIE]);
  return decision === 'granted' ? 'granted' : 'suppressed';
}
