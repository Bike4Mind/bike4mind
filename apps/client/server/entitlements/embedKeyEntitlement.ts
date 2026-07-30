import { CreditHolderType, type ApiKeyBillingOwnerType, type IEmbedBranding } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { EMBED_WHITELABEL_ENTITLEMENT_KEY, normalizeTag } from '@client/lib/entitlements/registry';
import type { EntitlementKey } from '@client/lib/entitlements/types';
import { getUserEntitlements } from './index';

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
 * Write-side enforcement for the key create/update routes: block an unentitled
 * `hideBranding` elevation while leaving every other branding field intact.
 * Owner-scoped (`embedKeyOwnerHasEntitlement`), sharing the exact rule the
 * authoritative read gate applies - white-label follows the key's billing owner
 * plan, not the acting caller, so an admin/developer configuring a key for an
 * unentitled owner can no longer persist a `true` the read side would strip.
 * Strips silently rather than 403ing - the flag is a cosmetic preference, and a
 * rejection would both leak entitlement state and block the legitimate save of
 * the other branding fields in the same request.
 *
 * `storedHideBranding` is the value currently on the key (false for a create).
 * Only a genuine elevation (stored-not-true -> incoming true for an unentitled
 * owner) is stripped; an ECHO of an already-stored true is preserved, so an
 * unentitled org member editing an unrelated branding field (e.g. the color)
 * does not silently clobber white-label the org already earned. Preserving a
 * stale stored true is safe: the read gate re-checks live and shows branding
 * anyway if the plan lapsed.
 */
export async function gateEmbedBrandingWrite(
  owner: EmbedKeyOwnerRef,
  branding: IEmbedBranding | undefined,
  storedHideBranding = false
): Promise<IEmbedBranding | undefined> {
  if (!branding || branding.hideBranding !== true) return branding;
  if (storedHideBranding === true) return branding; // echo, not an elevation
  const entitled = await embedKeyOwnerHasEntitlement(owner, EMBED_WHITELABEL_ENTITLEMENT_KEY).catch(() => false);
  if (entitled) return branding;
  return { ...branding, hideBranding: false };
}
