/**
 * Namespace prefix for the per-lake join meta-tag (`datalake:<slug>` or
 * `datalake:<org>:<slug>`). This meta-tag is what makes a file a MEMBER of a lake, so it is
 * a protected/reserved tag: only a user who can manage the target lake may apply it. Used to
 * detect lake-membership tags on the file write paths (see `assertCanWriteDataLakeTags`).
 */
export const DATALAKE_TAG_PREFIX = 'datalake:';

/**
 * Trim a lake's `fileTagPrefix` and return it only if it is usable as a tag prefix
 * (non-empty, ends with ':'), else null. An empty prefix would match every tag, so it is
 * rejected rather than honored.
 *
 * Shared by `buildOwnershipConditions`' prefix arms and the single-file removal write, which
 * is what keeps a removal clearing the same prefixed tags the lake read scope matches. Other
 * prefix readers (the tag-count aggregates) still build their own regexes, so this is a
 * guarantee about those two, not about every prefix match in the codebase.
 */
export const normalizeTagPrefix = (prefix: string | undefined | null): string | null => {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  return trimmed.length > 0 && trimmed.endsWith(':') ? trimmed : null;
};

/**
 * True when a would-be `fileTagPrefix` sits inside the `datalake:` namespace, which holds every
 * lake's membership meta-tag. Such a prefix would make one lake's content prefix match other
 * lakes' membership tags. Shared by the create schema and the wizard's client-side gate so the
 * form blocks it instead of failing at submit.
 */
export const isReservedTagPrefix = (prefix: string | undefined | null): boolean =>
  typeof prefix === 'string' && prefix.trim().startsWith(DATALAKE_TAG_PREFIX);

/**
 * True when two `fileTagPrefix` values would match each other's tags, so two lakes carrying them
 * cannot safely coexist in one scope: they would share their prefix-tagged files, and permanently
 * deleting either would take files the other holds.
 *
 * BIDIRECTIONAL, because a `docs:` lake matches a `docs:legal:foo` tag - so `docs:` and
 * `docs:legal:` conflict whichever way round they are declared. Unusable prefixes (empty, or
 * missing the trailing colon) never overlap: no query arm is built from them.
 *
 * Case-SENSITIVE, matching the membership predicate it guards: that builds an unflagged
 * `new RegExp('^' + prefix)`, so a `Docs:` lake and a `docs:` lake genuinely cannot reach each
 * other's tags and refusing the pair would be a false alarm. Comparing case-insensitively here
 * would make the guard a different rule from the thing it protects.
 *
 * Shared by the create/visibility guards, the teardown warning, and the wizard's form-level
 * mirror, so all of them agree on what counts as a conflict.
 */
export const tagPrefixesOverlap = (a: string | undefined | null, b: string | undefined | null): boolean => {
  const left = normalizeTagPrefix(a);
  const right = normalizeTagPrefix(b);
  if (!left || !right) return false;
  return left === right || left.startsWith(right) || right.startsWith(left);
};

/**
 * The reason a `fileTagPrefix` is unusable, as user-facing copy, or null when it is fine. Shared
 * by the wizard steps that can both edit a prefix so their wording cannot drift apart; the server
 * rejects both cases at create.
 */
export const tagPrefixIssue = (
  prefix: string | undefined | null,
  overlapping?: { name: string; fileTagPrefix: string } | null
): string | null => {
  if (isReservedTagPrefix(prefix)) {
    return `"${DATALAKE_TAG_PREFIX}" is reserved for lake membership. Pick another prefix, such as legal:`;
  }
  if (overlapping) {
    return `This prefix overlaps the data lake "${overlapping.name}" (${overlapping.fileTagPrefix}). They would share files, so deleting either one would take the other's.`;
  }
  return null;
};

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
  /**
   * Public opt-in (see IDataLake.isPublic). Surfaced so the Settings form can derive the
   * tri-state visibility (private | organization | public) from the list endpoint.
   */
  isPublic?: boolean;
  /**
   * Whether the requesting caller may WRITE/MANAGE this lake (add files, edit settings,
   * archive, remove files). Server-computed per request from the manage rule (admin or
   * creator; fallback lakes are read-only for everyone) - the SAME predicate the write
   * paths enforce (see canManageLake). The client renders it, never decides it: the list
   * now surfaces other users' public lakes (read-only), so management affordances gate on
   * this. Absent on projections that don't resolve an actor (e.g. tag-only lookups).
   */
  canManage?: boolean;
}

/**
 * DataLakeConfig plus the fields only a lake's EDITORS may read. Returned exclusively by the
 * actor-aware list projections (listDataLakes / listAllDataLakes), which populate the extra
 * fields per lake and only when `canManage` holds for the requesting caller.
 *
 * This is a separate type on purpose: DataLakeConfig is the shared shape the access filters and
 * the tag/registry projections all operate on, and several of those have no actor to gate on.
 * `toDataLakeConfig` is therefore structurally unable to carry an editor-only field - the
 * invariant that keeps the prompt text out of every actor-less projection (see
 * getAccessibleDataLakePrompts, which reads it off the raw documents for the same reason).
 */
export interface ManageableDataLakeConfig extends DataLakeConfig {
  /**
   * Per-lake system prompt (see IDataLake.systemPrompt). EDITOR-ONLY: a user who can merely
   * read the lake must never receive the wording, only its effect on answers. Present only
   * when the caller can manage this lake; `undefined` otherwise (never an empty-string stand-in,
   * so "not yours to see" and "set to blank" stay distinguishable).
   */
  systemPrompt?: string;
}

/**
 * A public data lake as it appears in the discover/browse surface: the lightweight card
 * projection returned by the `/api/data-lakes/public` browse endpoint. Distinct from
 * DataLakeConfig - it drops the access/gate internals (a browseable lake is gate-less by
 * construction) and adds the human-facing preview metadata the catalog renders: owner
 * display, file count, and total size. `ownerDisplayName` is deliberately name-or-username
 * only (never the owner's email) so browsing a public lake can't leak a cross-org address.
 */
export interface PublicDataLakeSummary {
  id: string;
  slug: string;
  name: string;
  description?: string;
  fileTagPrefix: string;
  /** name || username of the lake's creator; undefined if the owner could not be resolved. */
  ownerDisplayName?: string;
  /** Cached file count (0 when the lake has no files yet). */
  fileCount: number;
  /** Cached total size in bytes (0 when empty). */
  totalSizeBytes: number;
  /** True when the browsing caller created this lake (rendered as an "Owned by you" hint). */
  isOwn: boolean;
  /** True when the caller may manage the lake (admin or owner) - gates management affordances. */
  canManage: boolean;
}

/** One page of public-lake browse results plus the unpaged total for "showing X of Y". */
export interface BrowsePublicDataLakesResult {
  data: PublicDataLakeSummary[];
  total: number;
}

/**
 * Premium data lakes contributed by the private overlay via env, as JSON (open-core guard):
 * a customer-specific lake definition (its id/name/tag-prefix) names the customer and
 * doesn't belong in shippable code. Empty/unset in the open-core fork (or CI type-check)
 * means only the opti-knowledge base lake below, the correct default. Set the
 * NEXT_PUBLIC_PREMIUM_DATA_LAKES repo/org variable per stage to a JSON array of
 * DataLakeConfig objects to activate; the value is injected at deploy time per infra/deploy-contract.json.
 */
const PREMIUM_DATA_LAKES: DataLakeConfig[] = (() => {
  const raw = process.env.NEXT_PUBLIC_PREMIUM_DATA_LAKES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as DataLakeConfig[];
    return Array.isArray(parsed) ? parsed.filter(l => l && l.id && l.slug && l.fileTagPrefix && l.datalakeTag) : [];
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
  isPublic?: boolean;
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
    isPublic: dl.isPublic,
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
 * A requirement-less HARDCODED lake is accessible to all authenticated users - the registry
 * is curated, owner-less config. This does NOT hold for DB lakes: a requirement-less one is
 * owner-only unless org-scoped or public (Private-by-default, see canAccessLake). This
 * predicate has no ownership rule, so callers passing `dynamicDataLakes` MUST pre-filter them
 * through findAccessible / findActiveByUserTagsAndEntitlements, which enforce it datastore-side.
 * Having no ownership rule also means this drops a lake the caller CREATED whose own gate they
 * do not hold, so a caller that needs those must restore them AFTER filtering, from the
 * persisted `createdByUserId` - see the owner exemption in getDynamicDataLakeAccess.
 *
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
