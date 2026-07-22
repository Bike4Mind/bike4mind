import { CreditHolderType, type ApiKeyBillingOwnerType } from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { normalizeTag } from '@client/lib/entitlements/registry';
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
