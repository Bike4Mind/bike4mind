import { partnerSignupGrantForEmail } from '@server/entitlements/partnerRules';

/**
 * Whether a brand-new account may skip the invite gate because its email is on a partner domain.
 *
 * True only for an email whose ownership is already proven (an OTC code, or a provider-verified
 * address) AND whose exact domain matches an ENABLED partner signup rule in the database. The env
 * registry (NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS) is never consulted: partnerSignupGrantForEmail reads
 * only the DB rules (`findActiveRules` filters on `enabled`), keyed by the normalized domain after
 * the last `@`, so subdomains and lookalikes miss. Fails closed (false) when the rules cannot load.
 *
 * Shared by both self-serve gates - pages/api/otc/verify.ts and verifyCallback.ts - so they cannot
 * drift. Callers must still apply open-registration and bootstrap rules on their own.
 */
export async function isPartnerDomainSignupAllowed(
  email: string | null | undefined,
  emailVerified: boolean
): Promise<boolean> {
  if (emailVerified !== true || !email) return false;
  const grant = await partnerSignupGrantForEmail(email, true);
  return grant.matched;
}
