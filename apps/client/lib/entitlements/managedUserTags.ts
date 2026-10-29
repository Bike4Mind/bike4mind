import { PENDING_FREE_CREDITS_TAG, RESERVED_PARTNER_RULE_TAGS } from '@bike4mind/common';
import { allKnownEntitlementKeys, grantTagForEntitlement, isDatalakeEntitlementKey, normalizeTag } from './registry';

const managedTags = new Set([
  normalizeTag(PENDING_FREE_CREDITS_TAG),
  ...RESERVED_PARTNER_RULE_TAGS.map(normalizeTag),
  ...allKnownEntitlementKeys().map(normalizeTag),
  ...allKnownEntitlementKeys().flatMap(key => {
    const tag = grantTagForEntitlement(key);
    return tag ? [normalizeTag(tag)] : [];
  }),
]);

/** Role and product grants are owned by their dedicated actions, not the free-form tag editor. */
export const isManagedTag = (tag: string): boolean =>
  managedTags.has(normalizeTag(tag)) || isDatalakeEntitlementKey(tag);
