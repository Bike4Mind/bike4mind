import { ForbiddenError, PENDING_FREE_CREDITS_TAG, RESERVED_PARTNER_RULE_TAGS, isFullAdmin } from '@bike4mind/common';
import {
  allKnownEntitlementKeys,
  grantTagForEntitlement,
  isDatalakeEntitlementKey,
  normalizeTag,
} from '@bike4mind/server-utils/lib/entitlements/registry';

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

const managedTokens = (tags: readonly string[] | null | undefined): string =>
  JSON.stringify([...new Set((tags ?? []).map(tag => tag.trim()).filter(isManagedTag))].sort());

/**
 * True when the managed tags differ between two tag lists. Exact after trimming, not case-folded:
 * role gates such as hasDeveloperUserTag match exact spellings, so a case change can grant or revoke.
 */
export const managedTagsChanged = (
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): boolean => managedTokens(before) !== managedTokens(after);

/**
 * Tags on a grant package, partner rule or the defaultTags setting land on every account they reach,
 * so adding, removing or re-casing a managed tag there stays full-admin only, as in the tag editor.
 */
export function assertCanChangeManagedTags(
  user: Parameters<typeof isFullAdmin>[0],
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): void {
  if (!isFullAdmin(user) && managedTagsChanged(before, after)) {
    throw new ForbiddenError('Only full administrators can assign managed tags');
  }
}
