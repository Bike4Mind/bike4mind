/**
 * Namespace prefix for the per-lake join meta-tag (`datalake:<slug>` or
 * `datalake:<org>:<slug>`). This meta-tag is what makes a file a MEMBER of a lake, so it is
 * a protected/reserved tag: only a user who can manage the target lake may apply it. Used to
 * detect lake-membership tags on the file write paths (see `assertCanWriteDataLakeTags`).
 */
export const DATALAKE_TAG_PREFIX = 'datalake:';

/**
 * Relevance weight stored on the membership meta-tag itself. Membership is binary - the tag is
 * either there or it isn't - so this is a constant, not a score. It exists only because every
 * tag carries a strength; keep every door that stamps the meta-tag agreeing on one value, or the
 * same membership reads as differently weighted depending on which door wrote it.
 */
export const DATALAKE_TAG_STRENGTH = 1;

/**
 * Trim a lake's `fileTagPrefix` and return it only if it is usable as a tag prefix
 * (non-empty, ends with ':'), else null. An empty prefix would match every tag, so it is
 * rejected rather than honored.
 *
 * The one gate on "is this prefix usable at all", so everything that builds a prefix arm or
 * writes a prefixed tag agrees: the read arms in `buildOwnershipConditions`, the membership
 * predicate, the single-file removal write, the browse surface's `splitTagPrefixes`, the
 * collision checks, and the fallback tag stamper. What the read scope matches, what a removal
 * clears, what the tag-count aggregates count, and what the stamper writes therefore line up.
 *
 * The aggregates still build their own regexes from whatever list they are handed, so a
 * caller that reaches them without going through `splitTagPrefixes` is outside this
 * guarantee - they defend themselves by dropping unusable entries.
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
 * Does any of these tag names already place a file under `prefix`?
 *
 * The ONE satisfaction rule, so the write-door reconciler and the backfill migration cannot
 * disagree about which files still need a content tag. `buildLacksContentPrefixTagFilter` in
 * `@bike4mind/database` is its Mongo mirror; a parity test asserts they agree.
 *
 * Case-SENSITIVE on purpose, unlike the meta-tag match: the consumers that decide whether the
 * file shows up under the prefix - `buildOwnershipConditions` and the tag-count aggregates -
 * build their regexes with no `i` flag, so `Acme:legal` genuinely does not satisfy `acme:`
 * for them. Lowercasing here would skip the stamp on a file those queries still see as
 * uncategorized.
 *
 * A meta-tag never satisfies a prefix (the counters exclude `datalake:*` from the tree), and
 * neither does a bare `acme:` with no suffix: that splits to `['acme', '']` and renders as an
 * unlabeled row in the tag tree, so it is not a category a user can navigate to.
 */
export const satisfiesTagPrefix = (tagNames: readonly unknown[], prefix: string): boolean =>
  tagNames.some(
    name =>
      typeof name === 'string' &&
      name.startsWith(prefix) &&
      name.length > prefix.length &&
      !name.toLowerCase().startsWith(DATALAKE_TAG_PREFIX)
  );

/**
 * The tag names that place a file under a lake's PREFIX ARM - the exact JS mirror of the
 * `$regex: ^prefix` membership arm in `buildDataLakeMembershipFilter` (`@bike4mind/database`),
 * and of the `prefixedTags` computed inline inside `removeFileFromLake`.
 *
 * Deliberately NOT `satisfiesTagPrefix`, which is the fallback-STAMP rule: it also requires a
 * suffix (a bare `lk:` is not a category anyone can navigate to) and excludes meta-tags. The read
 * arm's regex has neither restriction - a bare `lk:` tag genuinely IS membership - so a gate
 * built on `satisfiesTagPrefix` would miss exactly the leave this predicate exists to catch.
 *
 * Fails closed to `[]` on an unusable or reserved-namespace prefix, matching the read arm (which
 * drops the whole prefix clause in both cases). Case-SENSITIVE, matching the read arm's unflagged
 * regex.
 */
export const prefixArmTagNames = (tagNames: readonly unknown[], fileTagPrefix: string | undefined | null): string[] => {
  const prefix = normalizeTagPrefix(fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return [];
  return tagNames.filter((name): name is string => typeof name === 'string' && name.startsWith(prefix));
};

/** True when any tag names a file under a lake's prefix arm. See `prefixArmTagNames`. */
export const matchesTagPrefixArm = (tagNames: readonly unknown[], fileTagPrefix: string | undefined | null): boolean =>
  prefixArmTagNames(tagNames, fileTagPrefix).length > 0;

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

// Codepoints that render blank despite carrying an "ink" Unicode category (Hangul and
// halfwidth fillers are Lo, braille blank is So, Khmer inherent vowels are Mn) - stripped
// before the ink test in hasBlankTagPrefixSegment.
const INVISIBLE_INK = /\u115F|\u1160|\u17B4|\u17B5|\u2800|\u3164|\uFFA0/g;

/**
 * True when any ":"-separated segment of the prefix (ignoring the trailing colon) has no
 * character that renders ink. A negated-whitespace test is not enough: format characters
 * (U+200B/U+2060, category Cf) survive `trim()`, and a handful of letter/symbol codepoints
 * (INVISIBLE_INK above) render blank too - all producing the same blank tree node. So
 * require a letter, number, punctuation, symbol, or mark after stripping the known blanks.
 * Shared by CreateDataLakeRequestInput's schema refine and the wizard mirror below so the
 * server and client rules cannot drift.
 */
export const hasBlankTagPrefixSegment = (prefix: string): boolean => {
  const body = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
  return body.split(':').some(part => !/[\p{L}\p{N}\p{P}\p{S}\p{M}]/u.test(part.replace(INVISIBLE_INK, '')));
};

/**
 * The reason a `fileTagPrefix` is unusable, as user-facing copy, or null when it is fine. Shared
 * by the wizard steps that can both edit a prefix so their wording cannot drift apart; the server
 * rejects all three cases at create.
 */
export const tagPrefixIssue = (
  prefix: string | undefined | null,
  overlapping?: { name: string; fileTagPrefix: string } | null
): string | null => {
  // Blank-segment before reserved, matching the schema's refine order, so both surfaces
  // name the same culprit for an input like "datalake::".
  if (prefix && hasBlankTagPrefixSegment(prefix)) {
    return 'Every ":" segment of the prefix needs a visible character (e.g. legal: or legal:contracts:).';
  }
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
   * URL/tag slug, unique per org. Kept on the projection because a client holding a lake still
   * reads it - the wizard checks its length to explain a rejected create. Uploads target a lake
   * by id instead: the server can disambiguate a slug out from under the client.
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
  /**
   * Preferred registry system-prompt id (see IDataLake.preferredSystemPromptId). EDITOR-ONLY,
   * like `systemPrompt`: surfaced only when the caller can manage the lake, so the settings
   * picker can seed its current selection. Absent (never an empty-string stand-in) otherwise,
   * so "not yours to see" and "no preferred prompt" stay distinguishable.
   */
  preferredSystemPromptId?: string;
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
