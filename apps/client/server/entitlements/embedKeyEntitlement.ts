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
    if (info.billingOwnerType === CreditHolderType.Organization) {
      // Org-billed key: the entitlement is the org billing owner's, never the
      // minter's. Assert positive ownership rather than falling through - a
      // missing organizationId (which create-time invariants forbid, but assert
      // here too) means we cannot resolve the owner, so fail closed instead of
      // silently checking the minter's plan.
      if (!info.organizationId) return false;
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
 * Write-side defense in depth for the key create/update routes: block a CALLER
 * who lacks the whitelabel entitlement from ELEVATING `hideBranding` to true,
 * leaving every other branding field intact. Deliberately caller-scoped
 * (requestHasEntitlement, admin bypass included) while the read side above is
 * owner-scoped: the read side is authoritative and fail-safe, so any scope
 * mismatch resolves to "branding shows", never the reverse. Strips silently
 * rather than 403ing - the flag is a cosmetic preference, and a rejection would
 * both leak entitlement state and block the legitimate save of the other
 * branding fields in the same request.
 *
 * `storedHideBranding` is the value currently on the key (false for a create).
 * Only a genuine elevation (stored-not-true -> incoming true by an unentitled
 * caller) is stripped; an ECHO of an already-stored true is preserved, so an
 * unentitled org member editing an unrelated branding field (e.g. the color)
 * does not silently clobber white-label the org already earned. Preserving a
 * stale stored true is safe: the owner-scoped read gate re-checks live and shows
 * branding anyway if the plan lapsed.
 */
export async function gateEmbedBrandingWrite(
  req: EntitlementRequest,
  branding: IEmbedBranding | undefined,
  storedHideBranding = false
): Promise<IEmbedBranding | undefined> {
  if (!branding || branding.hideBranding !== true) return branding;
  if (storedHideBranding === true) return branding; // echo, not an elevation
  const entitled = await requestHasEntitlement(req, EMBED_WHITELABEL_ENTITLEMENT_KEY).catch(() => false);
  if (entitled) return branding;
  return { ...branding, hideBranding: false };
}
