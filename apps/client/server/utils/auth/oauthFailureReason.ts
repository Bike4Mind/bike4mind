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
  'internal',
] as const;

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
 * Canonical reason -> user-facing redirect message. Derived only from the
 * whitelisted reason, never from `info.message` or raw error text.
 */
export function oauthFailureRedirectMessage(reason: OAuthFailureReason): string {
  switch (reason) {
    case 'state_expired':
      return 'Your login request expired. Please try again.';
    default:
      return 'Authentication failed';
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
