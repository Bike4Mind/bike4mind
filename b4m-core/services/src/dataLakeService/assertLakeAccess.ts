import type {
  AccessContext,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
} from '@bike4mind/common';
import { DATA_LAKES, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { BadRequestError, NotFoundError, normalizeId } from '@bike4mind/utils';
import { canManageLake, type LakeGrant } from './manageRule';

interface AssertLakeAccessAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
    // Optional: when wired, a transferred/delegated owner or curator reaches the lake through the
    // single read gate too (canAccessLake delegates to the grant-aware canManageLake). Absent ->
    // read access falls back to createdByUserId + org/tag/public, the pre-grant behavior.
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
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
  ctx: AccessContext,
  grants: readonly LakeGrant[] = []
): boolean {
  if (canManageLake(lake, ctx, grants)) return true;

  const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
  const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);

  // Public: readable app-wide - bypasses BOTH the org prerequisite and Private-by-default. Must
  // run before those checks (a public gateless lake trips the private rule otherwise). The gate
  // is STILL respected via lakeMatchesAccess (defense in depth: a gate added after publishing
  // keeps holding), but a normal public lake is gate-less so this returns true for everyone.
  if (lake.isPublic) return lakeMatchesAccess(lake, normalizedTags, normalizedKeys);

  // Normalize the lake's org id ONCE up front so "does this lake have an org" (private-by-default,
  // below) and "does the org match" (further down) agree on the same value. If they diverged - raw
  // truthiness here, normalized value there - a truthy-but-not-id-shaped org would read as
  // "has an org" (skip the private deny) yet normalize to undefined (skip the org-match deny),
  // letting a gate-less lake fall through to lakeMatchesAccess and become world-readable. Sharing
  // lakeOrgId keeps the gate failing CLOSED.
  const lakeOrgId = normalizeId(lake.organizationId);

  // Private (no org, no gate of any kind) -> owner/admin only; deny every other caller.
  // Must run before lakeMatchesAccess, which treats a no-requirement lake as public.
  if (!lakeOrgId && !lake.requiredUserTag && !lake.requiredEntitlement) return false;

  // Org is a hard prerequisite when the lake is org-scoped - evaluated BEFORE the
  // tag/entitlement any-of so a non-member can never pass. Membership is the SET the
  // context resolved from the org ACLs (#1674); the lake side still normalizes because
  // a hydrated lake doc can carry an ObjectId.
  // `?? []`: a runtime belt against a malformed ctx, not a widening of the declared (required)
  // type - a missing set must deny, not throw or vacuously allow.
  if (lakeOrgId && !(ctx.organizationIds ?? []).includes(lakeOrgId)) return false;

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
 * Refuse access-grant (membership) operations against a fallback lake. A hardcoded DATA_LAKES lake
 * has no backing document, so there is nothing to hang a grant row on and no `createdByUserId` to
 * seed an owner grant from - its access is curated config, granted to everyone via the list/read
 * path. This is the explicit fallback carve-out issue #1667 calls for; every grant write path
 * (add/remove/reprocess a member) must call it after the access gate, mirroring how
 * `assertLakeWritable` guards the file-write paths.
 */
export function assertLakeGrantable(lake: Pick<IDataLakeDocument, 'id'>): void {
  if (isFallbackLake(lake)) {
    throw new BadRequestError('This data lake is built into the platform; its membership is managed by configuration');
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
  const configOrgId = normalizeId(config.organizationId);
  // `?? []`: same runtime belt as canAccessLake above - a malformed ctx must deny, not throw.
  if (configOrgId && !(ctx.organizationIds ?? []).includes(configOrgId)) return null;
  if (!ctx.isAdmin) {
    const normalizedTags = ctx.userTags.map(t => t.toLowerCase());
    const normalizedKeys = (ctx.entitlementKeys ?? []).map(normalizeEntitlementKey);
    if (!lakeMatchesAccess(config, normalizedTags, normalizedKeys)) return null;
  }
  // Owner-less on purpose: reads key off datalakeTag/fileTagPrefix, and document writes
  // (rename/delete/visibility/file-removal) are refused wholesale by assertLakeWritable, so no
  // one is the creator. The one exception is assertLakeRebuildAccess (authorizeLakeWrite.ts),
  // which re-chunks files without mutating this document and gates on ctx.isAdmin directly.
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
    (await db.dataLakes.findBySlug(lakeIdOrSlug, ctx.organizationIds));
  if (lake) {
    // A persisted lake may carry grants; a fallback lake never does. Fetch only when the repo is
    // wired, so callers that have not threaded it keep the createdByUserId + org/tag/public behavior.
    const grants: LakeGrant[] =
      db.dataLakeAccessGrants && !isFallbackLake(lake)
        ? (await db.dataLakeAccessGrants.listByLake(lake.id, { activeAsOf: new Date() })).map(g => ({
            principalType: g.principalType,
            principalId: g.principalId,
            role: g.role,
          }))
        : [];
    if (!canAccessLake(lake, ctx, grants)) throw new NotFoundError('Data lake not found');
    return lake;
  }
  const fallback = resolveFallbackLake(lakeIdOrSlug, ctx);
  if (!fallback) throw new NotFoundError('Data lake not found');
  return fallback;
};
