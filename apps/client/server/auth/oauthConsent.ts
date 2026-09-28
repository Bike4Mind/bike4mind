import { requireEnv } from '@bike4mind/common';

/**
 * Audience (`aud`) stamped on relying-party OAuth access tokens (RFC 9068 sec 2.2 / RFC 8707).
 * B4M is currently both the authorization server and the only resource server, so this is the
 * B4M API's own identity; it is carried for standards shape and future multi-resource use rather
 * than enforced per-request (there is no second resource server to disambiguate yet).
 */
export function oauthAccessTokenAudience(): string {
  return requireEnv('APP_URL', process.env.APP_URL);
}

/** True when the granted scopes cover every requested scope. */
export function grantCovers(grantedScopes: string[], requestedScopes: string[]): boolean {
  return requestedScopes.every(s => grantedScopes.includes(s));
}

export type ConsentDecision = 'mint' | 'consent_required';

/**
 * Whether an authorization request may mint a code, or must first collect consent.
 * Pure so the authorize/token flow can be unit-tested without a DB. First-party clients never
 * prompt (legacy behavior). A relying-party mints only when the user just consented, or a
 * remembered grant already covers the requested scopes and no re-prompt was forced.
 */
export function decideConsent(params: {
  isRelyingParty: boolean;
  requestedScopes: string[];
  /** The user's currently-granted scopes for this client, or null if no grant exists. */
  grantedScopes: string[] | null;
  /** The user clicked Allow on THIS request. */
  consentGiven: boolean;
  /** OIDC prompt=consent: force the screen even when a grant already covers the scopes. */
  forceConsent: boolean;
}): ConsentDecision {
  if (!params.isRelyingParty) return 'mint';
  if (params.consentGiven) return 'mint';
  const covered = params.grantedScopes !== null && grantCovers(params.grantedScopes, params.requestedScopes);
  if (covered && !params.forceConsent) return 'mint';
  return 'consent_required';
}
