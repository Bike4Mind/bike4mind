/**
 * Helpers for safely auto-linking OAuth providers to existing local accounts.
 *
 * Background: The OAuth callback path silently linked any successful
 * OAuth login to a pre-existing local account whose email matched. That is the
 * canonical federated-identity account-takeover pattern (Zoom CVE-2023-39213,
 * Microsoft "nOAuth", Booking.com 2023). Auto-link is now gated on BOTH sides
 * of the email assertion being verified.
 */

/**
 * Error code returned to the OAuth callback strategy handler when auto-link
 * is refused. Surfaces to the user via /login?error=... so the UI can render a
 * "sign in with your existing credentials first, then link" prompt.
 */
export const ACCOUNT_LINK_VERIFICATION_REQUIRED = 'account_link_requires_verification';

/**
 * Returned when auto-link is refused because the provider email differs from
 * the local account email. Distinct from ACCOUNT_LINK_VERIFICATION_REQUIRED so
 * downstream UI can say "sign in with your existing method first" rather
 * than "verify your email address".
 */
export const ACCOUNT_LINK_EMAIL_MISMATCH = 'account_link_email_mismatch';

type EmailEntry = { value?: unknown; verified?: unknown; primary?: unknown };

/**
 * Normalise the `verified` field on a passport email entry. Providers (notably
 * Google) send it as the string `'true'` or `'false'`; raw truthiness is wrong
 * because the string `'false'` is truthy and would mark an unverified address as
 * verified.
 */
export function isVerifiedFlag(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Pick the best email from a passport profile:
 *   1. Primary AND verified
 *   2. Any verified (first one wins)
 *   3. emails[0] regardless (preserve existing behaviour as last resort)
 *   4. profile.email flat string fallback
 *
 * Returns the full entry object so callers can inspect `.value` and `.verified`.
 */
export function selectProviderEmail(profile: unknown): EmailEntry | null {
  if (!profile || typeof profile !== 'object') return null;
  const p = profile as Record<string, unknown>;

  const emails = p.emails;
  if (Array.isArray(emails) && emails.length > 0) {
    const entries = emails as EmailEntry[];
    const primaryVerified = entries.find(e => e.primary === true && isVerifiedFlag(e.verified));
    if (primaryVerified) return primaryVerified;
    const anyVerified = entries.find(e => isVerifiedFlag(e.verified));
    if (anyVerified) return anyVerified;
    return entries[0];
  }

  // Flat email fallback (some passport strategies / OIDC shapes)
  if (typeof p.email === 'string') return { value: p.email, verified: undefined };
  return null;
}

/**
 * Read `email_verified` from any of the shapes passport/OIDC providers expose.
 * - passport-google-oauth20: profile.emails[i].verified (often string 'true')
 * - OIDC / Okta userinfo: profile.email_verified or profile._json.email_verified
 * - SAML: profile.emails[i].verified is set explicitly by the SAML wrapper
 *   (SAML assertions are signed and the IdP attests user identity)
 * - GitHub: profile.emails returned via /user/emails carries `verified: boolean`
 *
 * Returns true only when the provider EXPLICITLY asserts the email is verified.
 * Absent or falsy fields are treated as unverified.
 *
 * Always evaluates the SAME email that selectProviderEmail() chose so the gate
 * and the match key can never disagree (split-brain risk).
 */
export function isProviderEmailVerified(profile: unknown): boolean {
  if (!profile || typeof profile !== 'object') return false;
  const p = profile as Record<string, unknown>;

  const selected = selectProviderEmail(profile);
  if (selected !== null) {
    const v = selected.verified;
    // Per-email explicit signal takes priority over any top-level claim.
    if (isVerifiedFlag(v)) return true;
    if (v === false || v === 'false') return false;
    // No per-email signal - fall through to top-level claims below.
  }

  if (p.email_verified === true) return true;

  const json = p._json;
  if (json && typeof json === 'object' && (json as Record<string, unknown>).email_verified === true) {
    return true;
  }

  return false;
}
