/**
 * Namespace prefix for the per-lake join meta-tag (`datalake:<slug>` or
 * `datalake:<org>:<slug>`). This meta-tag is what makes a file a MEMBER of a lake, so it is
 * a protected/reserved tag: only a user who can manage the target lake may apply it. Used to
 * detect lake-membership tags on the file write paths (see `assertCanWriteDataLakeTags`).
 */
export const DATALAKE_TAG_PREFIX = 'datalake:';

export interface DataLakeConfig {
  id: string;
  /**
   * URL/tag slug, unique per org. Needed by clients that resolve a lake by slug - notably
   * the Add-files (append) upload, which sends `dataLakeSlug` so the server can stamp the
   * lake meta-tag. Omitting it here silently broke append-mode registration.
   */
  slug: string;
  name: string;
  requiredUserTag?: string;
  /**
   * Generic entitlement gate (see IDataLake.requiredEntitlement). Matched against the
   * caller's resolved entitlement keys; namespaced + normalized (lowercase).
   */
  requiredEntitlement?: string;
  fileTagPrefix: string;
  datalakeTag: string;
  /** Org scope (undefined -> personal/org-less). Surfaced so clients can render visibility. */
  organizationId?: string;
  /**
   * Optional human-readable description. Surfaced so the Settings form can round-trip it
   * from the list endpoint (it seeds the form from the list, not the per-lake detail).
   */
  description?: string;
}

/**
 * Premium data lakes contributed by the private overlay via env, as JSON (open-core guard):
 * a customer-specific lake definition (its id/name/tag-prefix) names the customer and
 * doesn't belong in shippable code. Empty/unset in the open-core fork (or CI type-check)
 * means only the opti-knowledge base lake below, the correct default. Set the
 * NEXT_PUBLIC_PREMIUM_DATA_LAKES repo/org variable per stage to a JSON array of
 * DataLakeConfig objects to activate; the value flows in via _deploy-env.yml.
 */
const PREMIUM_DATA_LAKES: DataLakeConfig[] = (() => {
  const raw = process.env.NEXT_PUBLIC_PREMIUM_DATA_LAKES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DataLakeConfig[];
    return Array.isArray(parsed)
      ? parsed.filter(l => l && l.id && l.slug && l.fileTagPrefix && l.datalakeTag)
      : [];
  } catch {
    // Malformed value -> no premium lakes (fail closed); never throw at module load.
    return [];
  }
})();

export const DATA_LAKES: DataLakeConfig[] = [
  {
    id: 'opti-knowledge',
    slug: 'opti-knowledge',
    name: 'Optimization Knowledge Base',
    // OR-semantics: keep the legacy `Opti` tag AND add the entitlement, so
    // existing Opti-tagged users retain access while tag-less holders of
    // `optihashi:pro` (domain-based entitlement grants, future subscribers) also match.
    requiredUserTag: 'Opti',
    requiredEntitlement: 'optihashi:pro',
    fileTagPrefix: 'opti:',
    datalakeTag: 'datalake:opti-knowledge',
  },
  // Overlay-contributed customer lakes (e.g. the sales-intelligence lake) - absent in the fork.
  ...PREMIUM_DATA_LAKES,
];

/**
 * Canonical normalization for entitlement keys + `requiredEntitlement` values - the ONE
 * rule, applied at write time (create/update/stamp) and at match time. Mirrors the
 * entitlement registry's `normalizeTag` (trim + lowercase) so a value authored in any
 * casing matches the lowercase keys the resolver produces.
 */
export const normalizeEntitlementKey = (key: string): string => key.trim().toLowerCase();

/**
 * The ONE access predicate (generic, any-of declared requirements): a lake is accessible
 * iff it declares NO requirement, OR the user satisfies ANY declared requirement - either
 * `requiredUserTag` (matched against the user's tags) or `requiredEntitlement` (matched
 * against the caller's resolved entitlement keys). A lake declaring an entitlement but no
 * tag is therefore NOT public.
 *
 * Callers pass PRE-NORMALIZED inputs (tags lowercased; keys via `normalizeEntitlementKey`)
 * so the rule lives in exactly one place - shared by `getAccessibleDataLakes` (list), the
 * single-lake gate `canAccessLake`, and the `listDataLakes` hardcoded-fallback filter. The
 * two DB-side filters (`findActiveByUserTagsAndEntitlements`, `findAccessible`) are the
 * Mongo pre-filter mirror of this predicate; a parity test asserts they agree.
 */
export function lakeMatchesAccess(
  lake: Pick<DataLakeConfig, 'requiredUserTag' | 'requiredEntitlement'>,
  normalizedUserTags: string[],
  normalizedKeys: string[]
): boolean {
  const hasRequirement = !!lake.requiredUserTag || !!lake.requiredEntitlement;
  if (!hasRequirement) return true;
  const tagMatch = !!lake.requiredUserTag && normalizedUserTags.includes(lake.requiredUserTag.toLowerCase());
  const entMatch =
    !!lake.requiredEntitlement && normalizedKeys.includes(normalizeEntitlementKey(lake.requiredEntitlement));
  return tagMatch || entMatch;
}

/**
 * Single projection from a persisted lake document to the lightweight DataLakeConfig
 * the access filters operate on. Centralized so the `requiredEntitlement` field (and any
 * future field) cannot be silently dropped at one of the many former inline projections.
 */
export function toDataLakeConfig(dl: {
  id: string;
  slug: string;
  name: string;
  requiredUserTag?: string;
  requiredEntitlement?: string;
  fileTagPrefix: string;
  datalakeTag: string;
  organizationId?: string;
  description?: string;
}): DataLakeConfig {
  return {
    id: dl.id,
    slug: dl.slug,
    name: dl.name,
    requiredUserTag: dl.requiredUserTag,
    requiredEntitlement: dl.requiredEntitlement,
    fileTagPrefix: dl.fileTagPrefix,
    datalakeTag: dl.datalakeTag,
    organizationId: dl.organizationId,
    description: dl.description,
  };
}

/**
 * Returns data lakes accessible to a user.
 *
 * Access rule (generic, any-of declared requirements): a lake is accessible iff it
 * declares NO access requirement, OR the user satisfies ANY declared requirement -
 * either `requiredUserTag` (matched against the user's tags) or `requiredEntitlement`
 * (matched against the caller's resolved `entitlementKeys`). A lake declaring an
 * entitlement but no tag is therefore NOT public (it is gated by the key).
 *
 * Data lakes without any requirement are accessible to all authenticated users.
 * When dynamicDataLakes is provided (fetched from DB), those take precedence over
 * hardcoded DATA_LAKES entries with the same id. `entitlementKeys` is optional - callers
 * that don't resolve entitlements (tag-only surfaces) omit it and get tag-only matching.
 */
export function getAccessibleDataLakes(
  userTags: string[],
  dynamicDataLakes?: DataLakeConfig[],
  entitlementKeys?: string[]
): DataLakeConfig[] {
  const normalizedUserTags = userTags.map(tag => tag.toLowerCase());
  const normalizedKeys = (entitlementKeys ?? []).map(normalizeEntitlementKey);

  // Merge dynamic (DB) with hardcoded fallbacks
  let allLakes: DataLakeConfig[];
  if (dynamicDataLakes && dynamicDataLakes.length > 0) {
    const dynamicIds = new Set(dynamicDataLakes.map(d => d.id));
    const fallbacks = DATA_LAKES.filter(dl => !dynamicIds.has(dl.id));
    allLakes = [...dynamicDataLakes, ...fallbacks];
  } else {
    allLakes = DATA_LAKES;
  }

  return allLakes.filter(dl => lakeMatchesAccess(dl, normalizedUserTags, normalizedKeys));
}

/**
 * Returns the datalake: meta-tags for all data lakes a user can access.
 * Pass dynamicDataLakes from DB for runtime-registered data lakes, and entitlementKeys
 * so entitlement-gated lakes resolve consistently with getAccessibleDataLakes (callers
 * computing prefixes + tags must pass the SAME entitlementKeys to both, or the two sets
 * diverge).
 */
export function getDataLakeTags(
  userTags: string[],
  dynamicDataLakes?: DataLakeConfig[],
  entitlementKeys?: string[]
): string[] {
  return getAccessibleDataLakes(userTags, dynamicDataLakes, entitlementKeys).map(dl => dl.datalakeTag);
}
