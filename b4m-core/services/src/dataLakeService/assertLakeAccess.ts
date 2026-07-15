import type { AccessContext, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { DATA_LAKES, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

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
 * Public: an `isPublic` lake is readable app-wide - it bypasses the org prerequisite AND
 * Private-by-default (checked first), but the requirement gate still applies. Since a gated
 * lake can't be published (setLakeVisibility refuses it), a public lake is normally gate-less
 * and readable by everyone; the retained gate check is defense in depth for a post-publish gate.
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
  lake: Pick<
    IDataLakeDocument,
    'createdByUserId' | 'organizationId' | 'requiredUserTag' | 'requiredEntitlement' | 'isPublic'
  >,
  ctx: AccessContext
): boolean {
  if (ctx.isAdmin || lake.createdByUserId === ctx.userId) return true;

  const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);

  // Public: readable app-wide - bypasses BOTH the org prerequisite and Private-by-default. Must
  // run before those checks (a public gateless lake trips the private rule otherwise). The gate
  // is STILL respected via lakeMatchesAccess (defense in depth: a gate added after publishing
  // keeps holding), but a normal public lake is gate-less so this returns true for everyone.
  if (lake.isPublic) return lakeMatchesAccess(lake, normalizedTags, normalizedKeys);

  // Private (no org, no gate of any kind) -> owner/admin only; deny every other caller.
  // Must run before lakeMatchesAccess, which treats a no-requirement lake as public.
  if (!lake.organizationId && !lake.requiredUserTag && !lake.requiredEntitlement) return false;

  // Org is a hard prerequisite when the lake is org-scoped - evaluated BEFORE the
  // tag/entitlement any-of so a holder in a different org can never pass.
  if (lake.organizationId && lake.organizationId !== ctx.organizationId) return false;

  return lakeMatchesAccess(lake, normalizedTags, normalizedKeys);
}

/**
 * True when the lake is one of the hardcoded DATA_LAKES fallbacks (no Mongo document
 * backs it). Membership is by config id: config ids are human slugs, never ObjectId
 * hex strings, so a persisted lake can never collide.
 */
export function isFallbackLake(lake: Pick<IDataLakeDocument, 'id'>): boolean {
  return DATA_LAKES.some(dl => dl.id === lake.id);
}

/**
 * Refuse write/manage operations against a fallback lake. There is no document to
 * mutate, so every mutating endpoint must call this after the access gate - otherwise
 * the write path would die deeper in the service with a misleading not-found/500.
 */
export function assertLakeWritable(lake: Pick<IDataLakeDocument, 'id'>): void {
  if (isFallbackLake(lake)) {
    throw new BadRequestError('This data lake is built into the platform and is read-only');
  }
}

/**
 * Resolve a hardcoded DATA_LAKES fallback as a synthetic read-only document, applying
 * the same access rule the list path uses for fallbacks (admin, or tag/entitlement
 * any-of via lakeMatchesAccess) plus the hard org prerequisite from canAccessLake.
 * Unlike DB lakes, a gateless fallback is deliberately public: fallbacks are curated
 * config, not user-created, and the list path already shows them to everyone.
 */
function resolveFallbackLake(lakeIdOrSlug: string, ctx: AccessContext): IDataLakeDocument | null {
  const config = DATA_LAKES.find(dl => dl.id === lakeIdOrSlug || dl.slug === lakeIdOrSlug);
  if (!config) return null;
  if (config.organizationId && config.organizationId !== ctx.organizationId) return null;
  if (!ctx.isAdmin) {
    const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
    const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);
    if (!lakeMatchesAccess(config, normalizedTags, normalizedKeys)) return null;
  }
  // Owner-less on purpose: reads key off datalakeTag/fileTagPrefix, and writes are
  // refused wholesale by assertLakeWritable, so no one is the creator.
  return {
    ...config,
    createdByUserId: '',
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * The single access gate. Resolves a lake by id (then slug) from the DB, falling back
 * to the hardcoded DATA_LAKES configs (which have no backing document but are listed
 * by listDataLakes, so they must be openable). A DB lake always takes precedence - a
 * real lake that shadows a fallback slug resolves to the DB lake, and its denial is
 * final (no fallback retry). Denies with a NOT-FOUND-style error so a user who can't
 * see a lake can't confirm it exists. Every single-lake read and every batch/file
 * operation calls this first. Returns the lake on grant.
 */
export const assertLakeAccess = async (
  lakeIdOrSlug: string,
  ctx: AccessContext,
  { db }: AssertLakeAccessAdapters
): Promise<IDataLakeDocument> => {
  const lake =
    (await db.dataLakes.findById(lakeIdOrSlug).catch(() => null)) ??
    (await db.dataLakes.findBySlug(lakeIdOrSlug, ctx.organizationId));
  if (lake) {
    if (!canAccessLake(lake, ctx)) throw new NotFoundError('Data lake not found');
    return lake;
  }
  const fallback = resolveFallbackLake(lakeIdOrSlug, ctx);
  if (!fallback) throw new NotFoundError('Data lake not found');
  return fallback;
};
