/**
 * Trust anchor for federated logins: an identity provider may only assert emails
 * inside the domain it is registered for.
 *
 * Without this bind, `emailDomain` is only a routing hint on the way OUT (which IdP
 * to send a typed email to - see pages/api/auth/strategy.ts) and nothing checks it on
 * the way BACK IN. The administrator of any registered IdP could then assert any
 * address, and the email/username account lookup in verifyCallback.ts /
 * okta/callback.ts would resolve it to that victim's account across tenants.
 *
 * Shared by both federated entry points (the SAML strategy in server/auth/auth.ts and
 * the Okta OIDC callback) so the two can never drift; patching one alone would leave
 * the sibling exploitable.
 */

/**
 * Refusal code recorded on the AuthFailLog row and surfaced to the user via
 * /login?error=... Deliberately does not say which domain was expected.
 */
export const IDP_EMAIL_DOMAIN_MISMATCH = 'idp_email_domain_mismatch';

/**
 * True when `email` belongs to `emailDomain`. Exact domain match, case-insensitive:
 * `user@eu.acme.com` is NOT inside `acme.com`. Subdomains are excluded on purpose -
 * a delegated subdomain the customer does not fully control would otherwise widen
 * the identity space the IdP can assert into.
 *
 * Fails closed on anything it cannot evaluate (missing email, missing registered
 * domain, an address with no `@`).
 */
export function emailMatchesIdpDomain(
  email: string | null | undefined,
  emailDomain: string | null | undefined
): boolean {
  if (!email || !emailDomain) return false;

  // lastIndexOf, not split: a quoted local-part may legally contain '@', and the
  // domain is always what follows the LAST one.
  const at = email.lastIndexOf('@');
  if (at === -1) return false;

  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 && domain === emailDomain.trim().toLowerCase();
}
