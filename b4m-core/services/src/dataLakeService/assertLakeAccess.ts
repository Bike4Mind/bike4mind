import type {
  AccessContext,
  IAdminSettingsRepository,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IFallbackLakeSettingsRepository,
} from '@bike4mind/common';
import { DATA_LAKES, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import { BadRequestError, NotFoundError, normalizeId } from '@bike4mind/utils';
import type { LakeGrant } from './manageRule';
import { classifyLakeAccess } from './classifyLakeAccess';
import { resolveEnforceReadGrants, resolveLakeReadAccess, type LakeAccessLogger } from './resolveLakeReadAccess';

interface AssertLakeAccessAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'findBySlug'>;
    // Optional: when wired, a transferred/delegated owner or curator reaches the lake through the
    // single read gate too (canAccessLake delegates to the grant-aware canManageLake). Absent ->
    // read access falls back to createdByUserId + org/tag/public, the pre-grant behavior.
    dataLakeAccessGrants?: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
    // Optional: the read-time grant cutover flag (#1673). When wired, a persisted READER grant
    // resolves into an ephemeral membership view at the gate; the flag governs whether that
    // resolution is ENFORCED or merely reported (report-only). Absent -> report-only (legacy), so
    // a caller that has not threaded settings keeps exact pre-cutover behavior.
    settings?: Pick<IAdminSettingsRepository, 'getSettingsValue'>;
    // Optional: a static (registry) lake's admin-settable overlay (currently `groundingMode` only -
    // see IFallbackLakeSetting). Absent -> a fallback lake resolves exactly as it did before this
    // adapter existed (its coded default), so every caller that has not threaded it is unaffected.
    fallbackLakeSettings?: Pick<IFallbackLakeSettingsRepository, 'findByLakeId'>;
  };
  // Optional diagnostic sink for the report-only divergence line (the expected-grant-set diff).
  logger?: LakeAccessLogger;
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
  // ONE decision path: canAccessLake IS classifyLakeAccess().allowed. The classifier decomposes the
  // same five arms so the read-time grant cutover (#1673) can report which arm decided without a
  // drift-prone second copy of this rule.
  return classifyLakeAccess(lake, ctx, grants).allowed;
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
 *
 * `fallbackLakeSettings` merges in the registry lake's admin-settable overlay (currently
 * `groundingMode` only), when the caller has wired one. This is the ONE place a synthetic fallback
 * document is constructed, so it is the one seam an overlay value must reach for every downstream
 * consumer - sessions/create.ts reads `lake.groundingMode` straight off this return value via
 * resolveLakeSessionDefaults - to see it, with no per-consumer change. A read failure degrades to
 * the coded default rather than failing the request, matching every other optional adapter here.
 */
async function resolveFallbackLake(
  lakeIdOrSlug: string,
  ctx: AccessContext,
  fallbackLakeSettings?: Pick<IFallbackLakeSettingsRepository, 'findByLakeId'>
): Promise<IDataLakeDocument | null> {
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
  const overlay = fallbackLakeSettings ? await fallbackLakeSettings.findByLakeId(config.id).catch(() => null) : null;
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
    ...(overlay?.groundingMode ? { groundingMode: overlay.groundingMode } : {}),
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
  { db, logger }: AssertLakeAccessAdapters
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
    // Read-time grant resolution (#1673). Resolve the persisted READER grant into an ephemeral
    // membership view alongside the legacy five arms; the platform cutover flag governs whether that
    // resolution is ENFORCED or merely reported. A failed flag read degrades to report-only (legacy),
    // so a transient glitch can never silently WIDEN access.
    const enforceReadGrants = await resolveEnforceReadGrants(db.settings, logger);
    const decision = resolveLakeReadAccess(lake, ctx, grants, { enforceReadGrants });
    // The expected-grant-set diff: while report-only, log every case where the read grant WOULD
    // change the legacy outcome, so an operator can watch the cutover before flipping enforce on.
    // Deliberately NOT logged once enforced: post-flip a reader read is expected behavior, so a
    // per-access "diverges" line is just noise (grant-based access auditing is #1663's concern, not
    // the cutover's). The gate is the diff's whole purpose, so it lives only in the report-only phase.
    if (decision.diverges && !decision.enforced) {
      logger?.info?.('[lakeReadGrantCutover] read grant would change access (report-only)', {
        lakeId: lake.id,
        userId: ctx.userId,
        legacyArm: decision.legacyArm,
        legacyAllowed: decision.legacyAllowed,
        resolvedAllowed: decision.resolvedAllowed,
      });
    }
    if (!decision.allowed) throw new NotFoundError('Data lake not found');
    return lake;
  }
  const fallback = await resolveFallbackLake(lakeIdOrSlug, ctx, db.fallbackLakeSettings);
  if (!fallback) throw new NotFoundError('Data lake not found');
  return fallback;
};
