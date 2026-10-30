/**
 * Maps the `?error=` codes that auth handlers redirect to `/login` with into
 * user-facing messages. Without this the user is silently bounced back to the
 * login page with no explanation when SSO/OAuth fails.
 *
 * Codes are emitted by apps/client/pages/api/auth/* (okta, saml, ...) and
 * apps/client/app/routes/auth/success.tsx.
 */
const LOGIN_ERROR_MESSAGES = {
  // Okta
  okta_setup_failed:
    'Okta sign-in is temporarily unavailable. Please try another method or contact your administrator.',
  okta_config_missing: 'Okta sign-in isn’t configured for your account. Please contact your administrator.',
  okta_not_configured: 'Okta sign-in isn’t configured for your account. Please contact your administrator.',
  // SAML
  saml_auth_error: 'SAML sign-in failed. Please try again or use another method.',
  saml_auth_failed: 'SAML sign-in failed. Please try again or use another method.',
  saml_setup_failed:
    'SAML sign-in is temporarily unavailable. Please try another method or contact your administrator.',
  saml_signature_error: 'SAML sign-in couldn’t be validated. Please try again or contact your administrator.',
  // Provider / IdP resolution
  invalid_idp: 'That single sign-on provider isn’t recognized. Please try another method.',
  missing_idp_context: 'Your single sign-on session expired. Please try signing in again.',
  email_required: 'Your single sign-on account didn’t share an email address, which is required to sign in.',
  // Account linking (the email-equality gate refuses an auto-link)
  account_link_email_mismatch:
    'An account with this email already exists. Sign in with your existing method first, then link the new sign-in provider from your account settings.',
  account_link_requires_verification: 'Please verify your email address before linking this sign-in method.',
  // Session expiry - emitted by the API 401 interceptor when a token refresh fails
  // mid-session and the user is redirected to /login instead of being stranded.
  session_expired: 'Your session has expired. Please log in again.',
  // Security-forced logout - surfaced cross-tab when a session is revoked rather than
  // merely expired (e.g. the 3-strike MFA lockout via forceLogoutTokens).
  session_revoked: 'You were signed out for security. Please log in again.',
  // Generic flow failures
  invalid_id_token: 'Sign-in couldn’t be verified. Please try again.',
  invalid_state: 'Your sign-in session expired. Please try again.',
  missing_state: 'Your sign-in session expired. Please try again.',
  missing_code: 'Sign-in couldn’t complete. Please try again.',
  callback_error: 'Sign-in couldn’t complete. Please try again.',
  auth_setup_failed: 'Sign-in couldn’t complete. Please try again.',
  missing_tokens: 'Sign-in couldn’t complete. Please try again.',
  // Google/GitHub first sign-in while open registration is off; the login page also offers
  // the waitlist for this code (MultiStepLogin).
  registration_closed: 'Sign-ups are invite-only right now. Join the waitlist to request an invite.',
  // Google/GitHub first sign-in over the per-network signup cap; must equal the server's
  // SIGNUP_LIMITED_MESSAGE (server/utils/auth/oauthFailureReason.ts) so OTC and OAuth read the same.
  signup_limited: 'Too many new accounts from your network. Please try again later.',
  // Google/GitHub first sign-in refused: no provider-verified email, or a blocked email domain.
  verified_email_required:
    'Signing up needs a verified email address from your sign-in provider. Verify it there and try again, or sign up with your email instead.',
  signup_not_allowed: "We couldn't create an account with this sign-in. Please try another method.",
  server_configuration_error: 'A server configuration issue is preventing sign-in. Please contact your administrator.',
  // Turnstile challenge on the OAuth start route (apps/client/server/utils/auth/oauthStartTurnstile.ts)
  challenge_failed: 'Verification failed. Please try again.',
  challenge_unavailable:
    'Verification is temporarily unavailable. Please try again, or contact support if this persists.',
  // Second factor abandoned after an SSO sign-in (auth/success.tsx)
  mfa_required: 'Multi-factor authentication is required to sign in. Please sign in again and enter your code.',
  mfa_setup_required:
    'Your administrator requires multi-factor authentication. Please sign in again and complete the setup.',
  // Refusals from the OAuth guards (checkBlockedIP, oauthIpRateLimit)
  oauth_rate_limited: 'Too many sign-in attempts from your network. Please wait a few minutes and try again.',
  ip_blocked:
    'Sign-in is temporarily blocked from your network after repeated failed attempts. Please try again later or contact support.',
} satisfies Record<string, string>;

/** Union of all known `/login?error=` codes. Thread this through emitters
 *  (buildLoginRedirectUrl, the cross-tab reason->code map) so a typo'd code is a
 *  compile error instead of silently degrading to the generic fallback. */
export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

const GENERIC_LOGIN_ERROR = 'Sign-in failed. Please try again or use another method.';

/**
 * Returns a user-facing message for a `/login?error=` code, or `undefined` when
 * no code is present. Any non-empty but unrecognized code falls back to a
 * generic message so a failure is never silent.
 */
export const getLoginErrorMessage = (code: string | null | undefined): string | undefined => {
  if (!code) return undefined;
  // Cast for the lookup only: codes arrive from untrusted URL params, so any string must
  // be indexable; an unknown code falls through to the generic message.
  return (LOGIN_ERROR_MESSAGES as Record<string, string>)[code] ?? GENERIC_LOGIN_ERROR;
};
