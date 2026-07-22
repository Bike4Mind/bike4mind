import { CreditHolderType, type ApiKeyBillingOwnerType, type IEmbedBranding } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY, normalizeTag } from '@client/lib/entitlements/registry';
import type { EntitlementKey } from '@client/lib/entitlements/types';
import { getUserEntitlements, requestHasEntitlement, type EntitlementRequest } from './index';

/** The slice of ApiKeyInfo the owner resolution needs; structurally assignable. */
export interface EmbedKeyOwnerRef {
  /** Minting user - the owner for a user-billed key. */
  userId: string;
  billingOwnerType?: ApiKeyBillingOwnerType;
  organizationId?: string;
}

/**
 * Whether the embed key's BILLING OWNER holds the entitlement. For an org-billed
 * key that is the org's billing owner (`org.userId`), NOT the minting admin -
 * two admins on one org must resolve to the same plan, and a minter must not be
 * able to substitute their personal entitlements for the org's.
 *
 * Deliberately does NOT apply the `userHasEntitlement` admin bypass: white-label
 * is a plan feature of the owning account, not an operator privilege, and the
 * bypass would silently white-label every org whose billing owner is a staff
 * admin. Fails closed - any lookup error or missing owner resolves to false
 * (callers treat false as "branding shows").
 */
export async function embedKeyOwnerHasEntitlement(info: EmbedKeyOwnerRef, key: EntitlementKey): Promise<boolean> {
  try {
    let ownerUserId = info.userId;
    if (info.billingOwnerType === CreditHolderType.Organization && info.organizationId) {
      const org = await organizationRepository.findById(info.organizationId);
      if (!org?.userId) return false;
      ownerUserId = String(org.userId);
    }
    const owner = await userRepository.findById(ownerUserId);
    if (!owner) return false;
    const entitlements = await getUserEntitlements(owner);
    return entitlements.includes(normalizeTag(key));
  } catch {
    return false;
  }
}

/**
 * Write-side defense in depth for the key create/update routes: neutralize an
 * incoming `hideBranding: true` when the CALLER lacks the whitelabel
 * entitlement, leaving every other branding field intact. Deliberately
 * caller-scoped (requestHasEntitlement, admin bypass included) while the read
 * side above is owner-scoped: the read side is authoritative and fail-safe, so
 * any scope mismatch resolves to "branding shows", never the reverse. Strips
 * silently rather than 403ing - the flag is a cosmetic preference, and a
 * rejection would both leak entitlement state and block the legitimate save of
 * the other branding fields in the same request. Acts only on the incoming
 * object: a PATCH that omits branding never reaches this, so a stored
 * hideBranding is never proactively cleared (it is inert data the read gate
 * already ignores for unentitled owners).
 */
export async function gateEmbedBrandingWrite(
  req: EntitlementRequest,
  branding: IEmbedBranding | undefined
): Promise<IEmbedBranding | undefined> {
  if (!branding || branding.hideBranding !== true) return branding;
  const entitled = await requestHasEntitlement(req, EMBED_WHITELABEL_ENTITLEMENT_KEY).catch(() => false);
  if (entitled) return branding;
  return { ...branding, hideBranding: false };
}
