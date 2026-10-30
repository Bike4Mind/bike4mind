import type { LoginErrorCode } from '@client/app/utils/loginErrorMessages';

/**
 * Canonical, data-free OAuth failure reasons.
 *
 * This is the single source of truth for what may reach the shared OAuth
 * callback's (`[strategy]/callback.ts`) audit `reason` field or its redirect
 * query string. Emitters (verifyCallback's catch block, PassportOAuthStateStore)
 * attach a `code` from this set onto passport `info`; the callback then
 * default-denies through `resolveOAuthFailureReason` before writing anything
 * to the audit log or the redirect. Raw exception/DB error text must never
 * take this path - it goes to `console.error` (CloudWatch) only.
 */
export const OAUTH_FAILURE_REASONS = [
  'duplicate_account',
  'forbidden_system_user',
  'state_invalid',
  'state_expired',
  'state_missing',
  'registration_closed',
  'signup_limited',
  'signup_email_unverified',
  'signup_email_blocked',
  // Set by the callback itself from the provider's `?error=access_denied` (user cancelled consent).
  'access_denied',
  'internal',
] as const;

/** The one refusal both signup paths show (OTC via signupNetworkLimits, OAuth via the redirect below). */
export const SIGNUP_LIMITED_MESSAGE = 'Too many new accounts from your network. Please try again later.';

export type OAuthFailureReason = (typeof OAUTH_FAILURE_REASONS)[number];

const REASON_SET: ReadonlySet<string> = new Set(OAUTH_FAILURE_REASONS);

/**
 * Default-deny mapping from an untrusted `info.code` to a canonical reason.
 * Anything not on the whitelist - undefined, garbage, or an attempt to smuggle
 * raw error text through the `code` field - maps to `internal`.
 */
export function resolveOAuthFailureReason(code: unknown): OAuthFailureReason {
  return typeof code === 'string' && REASON_SET.has(code) ? (code as OAuthFailureReason) : 'internal';
}

/**
 * Canonical reason -> the `/login?error=` code the client maps to a user-facing message
 * (app/utils/loginErrorMessages.ts; must stay in sync). The login page only renders known
 * codes, so free text here would degrade to its generic fallback.
 */
export function oauthFailureLoginErrorCode(reason: OAuthFailureReason): LoginErrorCode {
  switch (reason) {
    case 'state_expired':
      return 'invalid_state';
    case 'registration_closed':
      return 'registration_closed';
    case 'signup_limited':
      return 'signup_limited';
    case 'signup_email_unverified':
      return 'verified_email_required';
    case 'signup_email_blocked':
      return 'signup_not_allowed';
    default:
      return 'callback_error';
  }
}

/**
 * Canonical codes for a state-token verification failure, keyed by
 * jwtStateStore's `VerifyResult['reason']`.
 */
export const STATE_REASON_TO_CODE: Record<'missing' | 'expired' | 'invalid', OAuthFailureReason> = {
  missing: 'state_missing',
  expired: 'state_expired',
  invalid: 'state_invalid',
};
