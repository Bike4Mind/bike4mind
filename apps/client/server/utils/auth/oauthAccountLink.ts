/**
 * Helpers for safely auto-linking OAuth providers to existing local accounts.
 *
 * Background: The OAuth callback path silently linked any successful
 * OAuth login to a pre-existing local account whose email matched. That is the
 * canonical federated-identity account-takeover pattern (Zoom CVE-2023-39213,
 * Microsoft "nOAuth", Booking.com 2023). Auto-link is now gated on BOTH sides
 * of the email assertion being verified.
 */

import { IAuthProviders } from '@bike4mind/common';

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

/** The error codes decideAutoLink can attach to a `refuse` outcome. */
export type AccountLinkRefusalCode = typeof ACCOUNT_LINK_VERIFICATION_REQUIRED | typeof ACCOUNT_LINK_EMAIL_MISMATCH;

/**
 * Log-only discriminant for WHY a link was refused. Finer-grained than `reason`
 * on purpose: both `provider_email_unverified` and `local_email_unverified` map
 * to the same public `ACCOUNT_LINK_VERIFICATION_REQUIRED` code (we don't tell the
 * user which half failed), but forensics during an attack needs to tell them
 * apart. Never surfaced to the client - for `Logger`/audit context only.
 */
export type AutoLinkRefusalDetail = 'provider_email_unverified' | 'email_mismatch' | 'local_email_unverified';

/**
 * Inputs to the auto-link decision. Each callback extracts these from its own
 * provider shape (OIDC boolean vs passport email-array) before delegating.
 * Emails are compared case-insensitively; pass them raw.
 */
export interface AutoLinkInput {
  /** Provider EXPLICITLY asserts the selected email is verified. */
  providerEmailVerified: boolean;
  /** The provider email the gate evaluated (the same one used as the match key). */
  providerEmail: string | null;
  /** The matched local account's email. Null for a username-only match. */
  localEmail: string | null;
  /** The local account's `emailVerified === true`. */
  localEmailVerified: boolean;
  /** The local account's `hasUsablePassword` (NOT `!!password` - see UserModel). */
  hasUsablePassword: boolean;
}

/**
 * Outcome of the auto-link decision:
 * - `link`            - safe to attach the provider; leave emailVerified as-is.
 * - `promote-and-link`- safe to attach AND promote the local email to verified
 *                       (the provider round-trip cryptographically attested it).
 * - `refuse`          - do not link; `reason` is the user-facing error code and
 *                       `detail` is the finer log-only cause (never shown).
 */
export type AutoLinkDecision =
  | { action: 'link' }
  | { action: 'promote-and-link' }
  | { action: 'refuse'; reason: AccountLinkRefusalCode; detail: AutoLinkRefusalDetail };

/**
 * The single OAuth auto-link security gate, shared by every callback path
 * (verifyCallback.ts for Google/GitHub/SAML, okta/callback.ts for Okta OIDC).
 *
 * This decides whether an incoming provider identity may attach to a matched
 * pre-existing local account - the federated-identity account-takeover surface
 * (nOAuth, Zoom CVE-2023-39213, Booking.com 2023). Callers apply it ONLY when
 * the incoming provider identity is NOT already bound to the account (i.e. not a
 * routine token refresh for the same sub); that same-identity exemption stays in
 * each caller because it is provider-specific identity math.
 *
 * The gate:
 *   1. Provider must EXPLICITLY assert the email is verified, else refuse.
 *   2. When both emails are present they must match (case-insensitive), else
 *      refuse as a mismatch - verification alone is insufficient because the
 *      account lookup matches on email OR username, so a verified provider email
 *      on a colliding username must not link into a victim account.
 *   3. Local side must also be verified, UNLESS the account has no usable
 *      password: a real-password + unverified-email account is the reverse-
 *      takeover setup (attacker pre-seeds the victim's email locally). A
 *      passwordless account can't be squatted that way and the provider just
 *      attested control of the email, so promote instead of dead-ending - but
 *      ONLY on a real verified-email match, never a username-only match.
 */
export function decideAutoLink(input: AutoLinkInput): AutoLinkDecision {
  const { providerEmailVerified, providerEmail, localEmail, localEmailVerified, hasUsablePassword } = input;

  if (!providerEmailVerified) {
    return { action: 'refuse', reason: ACCOUNT_LINK_VERIFICATION_REQUIRED, detail: 'provider_email_unverified' };
  }

  const emailsMatch = !!providerEmail && !!localEmail && providerEmail.toLowerCase() === localEmail.toLowerCase();

  // Mismatch only when both sides are present and differ; a username-only match
  // (localEmail null) is not a mismatch here - it fails the promotion test below.
  if (!!providerEmail && !!localEmail && !emailsMatch) {
    return { action: 'refuse', reason: ACCOUNT_LINK_EMAIL_MISMATCH, detail: 'email_mismatch' };
  }

  if (!localEmailVerified) {
    if (!hasUsablePassword && emailsMatch) {
      return { action: 'promote-and-link' };
    }
    return { action: 'refuse', reason: ACCOUNT_LINK_VERIFICATION_REQUIRED, detail: 'local_email_unverified' };
  }

  return { action: 'link' };
}

/**
 * Inputs to the account-link write. Each callback supplies its own account state
 * after the shared gate (decideAutoLink) has approved the link.
 */
export interface ApplyAccountLinkInput {
  /** The account's current providers (user.authProviders || []). Mutated in place. */
  authProviders: IAuthProviders[];
  /** The incoming provider credentials to link. */
  oauthCredentials: IAuthProviders;
  /** No existing entry for this strategy (existingProviderIndex === -1). */
  isNewProvider: boolean;
  /** decideAutoLink returned `promote-and-link`: also stamp the local email verified. */
  promoteEmailVerified: boolean;
  /** The account's current tokenVersion, used to compute the bumped value to reflect. */
  currentTokenVersion: number | undefined;
}

/**
 * The account-link write, split from its transport so callers just apply it:
 *   - `update`  : the second argument to User.updateOne.
 *   - `reflect` : the fields to mirror onto the in-memory user so the token minted
 *                 for THIS login matches what was just persisted.
 */
export interface AccountLinkWrite {
  update: Record<string, unknown>;
  reflect: { tokenVersion?: number; emailVerified?: boolean; emailVerifiedAt?: Date };
}

/**
 * Apply an approved account-link decision to the write layer. Shared by every
 * callback (verifyCallback.ts for Google/GitHub/SAML, okta/callback.ts for Okta
 * OIDC) so the security-relevant write - the tokenVersion bump on a new link and
 * the emailVerified promotion - can never drift between the two paths. Callers own
 * only their transport (session shape, audit event, HTTP response).
 *
 * Mutates `authProviders` in place (splice-or-push) exactly as the inline write
 * did, so a caller that copies the user afterwards (passport's omit(user)) still
 * observes the linked provider.
 *
 * Linking a NEW provider is security-relevant: the update nests the fields under
 * `$set` and increments tokenVersion to revoke other active sessions; the current
 * login stays valid because the caller reflects the bumped version onto the user
 * it mints this token from. A refresh of an already-linked provider replaces the
 * fields without a bump.
 *
 * A promotion write always rides the SAME updateOne as the link - no second
 * round-trip, and neither can persist without the other. Promotion only fires on a
 * real email match (see decideAutoLink), so the local email is always present - no
 * backfill needed.
 */
export function applyAccountLink({
  authProviders,
  oauthCredentials,
  isNewProvider,
  promoteEmailVerified,
  currentTokenVersion,
}: ApplyAccountLinkInput): AccountLinkWrite {
  const existingProviderIndex = authProviders.findIndex(p => p.strategy === oauthCredentials.strategy);
  if (existingProviderIndex !== -1) {
    authProviders[existingProviderIndex] = oauthCredentials;
  } else {
    authProviders.push(oauthCredentials);
  }

  const emailVerifiedAt = new Date();
  const emailVerifiedFields: { emailVerified?: true; emailVerifiedAt?: Date } = promoteEmailVerified
    ? { emailVerified: true, emailVerifiedAt }
    : {};

  const reflect: AccountLinkWrite['reflect'] = {};
  if (promoteEmailVerified) {
    reflect.emailVerified = true;
    reflect.emailVerifiedAt = emailVerifiedAt;
  }

  if (isNewProvider) {
    reflect.tokenVersion = (currentTokenVersion ?? 0) + 1;
    return {
      update: { $set: { oauthCredentials, authProviders, ...emailVerifiedFields }, $inc: { tokenVersion: 1 } },
      reflect,
    };
  }

  return {
    update: { oauthCredentials, authProviders, ...emailVerifiedFields },
    reflect,
  };
}

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
