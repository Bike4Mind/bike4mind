import { DATA_LAKES, ForbiddenError, isFullAdmin, normalizeEntitlementKey } from '@bike4mind/common';
import { dataLakeRepository } from '@bike4mind/database';
import { entitlementsForTags, normalizeTag } from '@bike4mind/server-utils/lib/entitlements/registry';

/**
 * The tags that would satisfy a data lake gate: equal to some lake's requiredUserTag, or granting
 * (through entitlementsForTags) a key equal to its requiredEntitlement. Covers stored and registry
 * lakes. Compared trimmed and case-folded, wider than the gates themselves match.
 */
export async function lakeGateTagsIn(tags: readonly string[]): Promise<string[]> {
  if (tags.length === 0) return [];
  const stored = await dataLakeRepository.findGateValues();
  const gateTags = new Set(
    [...stored.userTags, ...DATA_LAKES.flatMap(lake => (lake.requiredUserTag ? [lake.requiredUserTag] : []))].map(
      normalizeTag
    )
  );
  const gateKeys = new Set(
    [
      ...stored.entitlements,
      ...DATA_LAKES.flatMap(lake => (lake.requiredEntitlement ? [lake.requiredEntitlement] : [])),
    ].map(normalizeEntitlementKey)
  );
  return tags.filter(
    tag =>
      gateTags.has(normalizeTag(tag)) ||
      [...entitlementsForTags([tag])].some(key => gateKeys.has(normalizeEntitlementKey(key)))
  );
}

/**
 * Lake gate tags stay full-admin only on every path that adds or removes account tags (the tag
 * editor, account creation, bulk add/undo, grant packages, the defaultTags setting), alongside the
 * managed-tag rule in `lib/entitlements/managedUserTags.ts`, which stays free of this DB lookup
 * because the admin UI imports it. `tags` is what the write adds or removes.
 */
export async function assertCanChangeLakeGateTags(
  user: Parameters<typeof isFullAdmin>[0],
  tags: readonly string[] | undefined
): Promise<void> {
  if (isFullAdmin(user) || !tags?.length) return;
  if ((await lakeGateTagsIn(tags)).length > 0) {
    throw new ForbiddenError('Only full administrators can assign tags that gate data lake access');
  }
}

/**
 * assertCanChangeLakeGateTags over the tags a write adds or removes going from `before` to `after`.
 * Tags are diffed by exact spelling: lake gates match user tags without trimming, so re-spelling a
 * padded stored tag can change what it grants.
 */
export async function assertCanChangeLakeGateTagsBetween(
  user: Parameters<typeof isFullAdmin>[0],
  before: readonly string[] | null | undefined,
  after: readonly string[] | null | undefined
): Promise<void> {
  if (isFullAdmin(user)) return;
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  await assertCanChangeLakeGateTags(user, [
    ...(after ?? []).filter(tag => !beforeSet.has(tag)),
    ...(before ?? []).filter(tag => !afterSet.has(tag)),
  ]);
}
