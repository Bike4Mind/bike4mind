import type { AccessContext, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

interface AssertLakeAccessAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
  };
}

/**
 * Pure access decision for a lake the caller already holds. Bypass-then-constraints:
 * owner or admin is granted immediately; otherwise a non-owner must satisfy the org
 * constraint (if the lake is org-scoped) AND the requirement constraint - the requirement
 * is the generic any-of rule (`lakeMatchesAccess`): no requirement declared, OR a matching
 * `requiredUserTag`, OR a matching `requiredEntitlement`. Org stays a HARD prerequisite,
 * NOT folded into the any-of: a tag/entitlement holder in a different org is still denied.
 *
 * Private-by-default: a lake with NO org and NO gate (requiredUserTag/requiredEntitlement
 * all blank) grants a non-owner nothing, so it is owner/admin-only - never world-readable.
 * This is enforced BEFORE `lakeMatchesAccess` (whose any-of rule returns true for a
 * no-requirement lake, which would otherwise make it public). It mirrors the `notPrivate`
 * rule on the collection paths (findAccessible / findActiveByUserTagsAndEntitlements) so all
 * three access paths agree; without it, the single-lake gate would still hand a guessed-slug
 * private lake to any caller.
 */
export function canAccessLake(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement'>,
  ctx: AccessContext
): boolean {
  if (ctx.isAdmin || lake.createdByUserId === ctx.userId) return true;

  // Private (no org, no gate of any kind) -> owner/admin only; deny every other caller.
  // Must run before lakeMatchesAccess, which treats a no-requirement lake as public.
  if (!lake.organizationId && !lake.requiredUserTag && !lake.requiredEntitlement) return false;

  // Org is a hard prerequisite when the lake is org-scoped - evaluated BEFORE the
  // tag/entitlement any-of so a holder in a different org can never pass.
  if (lake.organizationId && lake.organizationId !== ctx.organizationId) return false;

  const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);
  return lakeMatchesAccess(lake, normalizedTags, normalizedKeys);
}

/**
 * The single access gate. Resolves a lake by id (then slug) and asserts access.
 * Denies with a NOT-FOUND-style error so a user who can't see a lake can't confirm
 * it exists. Every single-lake read and every batch/file operation calls this first.
 * Returns the lake on grant.
 */
export const assertLakeAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  { db }: AssertLakeAccessAdapters
): Promise<IDataLakeDocument> => {
  const lake =
    (await db.dataLakes.findById(lakeIdOrSlug).catch(() => null)) ??
    (await db.dataLakes.findBySlug(lakeIdOrSlug, ctx.organizationId));
  if (!lake || !canAccessLake(lake, ctx)) {
    throw new NotFoundError('Data lake not found');
  }
  return lake;
};
