import type { Request } from 'express';
import { APP_DECISION_COOKIE, DECISION_COOKIE } from '@client/app/utils/consentRegion';
import { parseCookies } from './cookies';

/**
 * Whether this request may have campaign attribution read off it, decided server-side.
 *
 * Precedence is the browser's, from resolveConsent: this origin's own decision first, then the
 * one the visitor made on the marketing site. The app cookie is published by the consent banner
 * on every load (publishResolvedConsent) and already folds in the region default, so reading it
 * first is what makes an in-app Accept visible here at all - the decision itself lives in
 * localStorage, which a request handler cannot see. Reading it first is equally what stops an
 * in-app decline being overridden by a stale shared grant: signup then suppresses exactly where
 * checkout would.
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
