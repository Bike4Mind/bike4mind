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
 * How a lake's attached corpus is grounded into a chat turn, as a DELIBERATE per-lake product
 * choice rather than a side effect of who is asking (see IDataLake.groundingMode):
 * - `inline`: paste the corpus into the prompt (never defer to the search tool).
 * - `retrieve`: leave the corpus to the offered search_knowledge_base tool (always defer the
 *   tool-retrievable subset), so an owner and an entitlement-only reader ground identically.
 * - `auto-by-size`: keep the size heuristic - defer only when the per-doc even-split inline depth
 *   falls below the `CorpusRetrievalMinInlineTokensPerDoc` floor (see shouldDeferCorpusToRetrieval).
 *
 * The resolution seam is create-time (resolveLakeSessionDefaults -> session.corpusGroundingMode);
 * the enforcement seam is the completion-path defer plan. Keep this tuple and DataLakeGroundingMode
 * as the single source both the Zod schema and the Mongoose enum derive from.
 */
export const DATA_LAKE_GROUNDING_MODES = ['inline', 'retrieve', 'auto-by-size'] as const;
export type DataLakeGroundingMode = (typeof DATA_LAKE_GROUNDING_MODES)[number];

/**
 * Default per-lake grounding mode: `retrieve`. Chosen so inline-vs-retrieve is a deliberate choice
 * that defaults SAFE - an owner and a reader of the same lake behave identically (retrieval) unless
 * an editor opts the lake into inlining. Applied to a lake that never set the field (including lakes
 * that predate it, whose stored value is absent) at the create-time resolution seam.
 */
export const DEFAULT_DATA_LAKE_GROUNDING_MODE: DataLakeGroundingMode = 'retrieve';

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
 * The prefix arm a membership scope RESOLVES TO, or null when the membership predicate drops it.
 *
 * The single decision behind two things that must never disagree: `buildDataLakeMembershipFilter`
 * (`@bike4mind/database`) builds its prefix arm from this, and any caller that DISCLOSES the scope it
 * queried reports it. Deriving a disclosure from the lake document instead is the bug this exists to
 * prevent - it claims an arm the filter dropped, so a number computed over the meta-tag alone is
 * presented as though the prefix arm had run (#2243). A registry lake is the reachable case: it has no
 * backing document, so `createdByUserId` is `''` and an `owned` scope fails closed to meta-tag-only
 * while the document still carries a real `fileTagPrefix`.
 *
 * Three reasons the arm is dropped, and the caller cannot tell them apart from the scope alone:
 * an unusable prefix, a reserved-namespace one, and an `owned` scope with no creator to anchor to.
 */
export const effectiveTagPrefixArm = (scope: {
  kind: 'owned' | 'registry';
  fileTagPrefix?: string | null;
  creatorUserId?: string | null;
}): string | null => {
  const prefix = normalizeTagPrefix(scope.fileTagPrefix);
  if (!prefix || isReservedTagPrefix(prefix)) return null;
  // An owned lake's prefix is user-chosen and unique only per creator, so with no creator there is
  // nothing safe to match on. A registry prefix is compile-time config and needs no anchor.
  if (scope.kind === 'owned' && !scope.creatorUserId) return null;
  return prefix;
};

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
 * Storage-time bounds for one AI-inferred taxonomy category, shared by `sanitizeCategories`
 * (utils/dataLakeTaxonomy.ts, the write path) and `ApplyTaxonomyRequestInput`'s Zod schema
 * (schemas/dataLake.ts, the apply request's validation). These MUST agree: a category
 * `sanitizeCategories` accepts and stores as `taxonomyStatus: 'ready'` has to be one apply's
 * request schema will also accept, or the batch becomes permanently un-applyable - accepted at
 * analysis time, then rejected on every apply attempt. Importing one shared source instead of
 * two independently-hardcoded numbers is what keeps that from silently drifting.
 */
export const MAX_TAXONOMY_TAGS = 100;
export const MAX_TAXONOMY_TAG_SUFFIX_LENGTH = 100;
export const MAX_TAXONOMY_TAG_ORIGINAL_NAME_LENGTH = 150;
export const MAX_TAXONOMY_MATCHING_FOLDERS_PER_TAG = 100;
export const MAX_TAXONOMY_MATCHING_FOLDER_LENGTH = 512;

/**
 * Length bounds for a `fileTagPrefix`, measured on the TRIMMED value INCLUDING its trailing ":" -
 * the same string `CreateDataLakeRequestInput` sizes after its own `.trim()`, so a value that is
 * exactly at the limit is judged identically on both sides.
 *
 * Exported so every surface that produces or judges a prefix bounds it by the same number: the
 * create schema, the wizard's form-level mirror (`tagPrefixIssue`), the Start Upload gate, the
 * prefix the wizard DERIVES from a lake name, and the 422 translator. The derive step is why the
 * max has to be shared rather than left to the schema: it builds the prefix out of a lake SLUG,
 * whose own max is twice this, so a long name used to hand the user a prefix the server refuses.
 */
export const MIN_TAG_PREFIX_LENGTH = 2;
export const MAX_TAG_PREFIX_LENGTH = 30;

/**
 * The longest a single tag name under a lake's prefix can be: the longest prefix plus the longest
 * taxonomy suffix a name under it could carry. Derived rather than hardcoded so it tracks
 * `MAX_TAG_PREFIX_LENGTH` and `MAX_TAXONOMY_TAG_SUFFIX_LENGTH` instead of drifting from either.
 * This bounds what a caller may WRITE under a prefix; it does not bound what the upload path may
 * already have stored there (folder-derived names are not truncated), so an existing name over
 * this length is a real, legitimate possibility a replace-semantics door must account for.
 */
export const MAX_LAKE_FILE_TAG_NAME_LENGTH = MAX_TAG_PREFIX_LENGTH + MAX_TAXONOMY_TAG_SUFFIX_LENGTH;

/**
 * Length bounds and shape for a lake `slug`, owned here rather than by the create schema because
 * the client PRODUCES the value it then sends: the wizard slugifies a lake name, truncates to the
 * max, and gates Start Upload on the min, all before the schema ever sees the result. A produced
 * value whose bound lives only in the schema is how the `fileTagPrefix` derive above came to hand
 * users a prefix the server refused, so keep the schema, `slugifyDataLakeName`,
 * `isValidDataLakeSlug`, the wizard's "name too short" copy and the 422 translator all reading
 * these.
 *
 * The regex is shared for the same reason in the other direction: `slugifyDataLakeName` satisfies
 * it BY CONSTRUCTION (it trims the edge hyphens truncation can expose), and the only thing that
 * keeps that true is a test asserting against this exact pattern.
 */
export const MIN_DATA_LAKE_SLUG_LENGTH = 2;
export const MAX_DATA_LAKE_SLUG_LENGTH = 60;
export const DATA_LAKE_SLUG_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * A typed prefix as the create request will actually carry it: trimmed, and closed with the
 * trailing ":" the wizard appends before POSTing.
 *
 * Every rule has to judge THIS value rather than the raw field, because the server judges the
 * submitted string: 30 characters with no colon arrive as 31 and are refused, while a bare "a"
 * arrives as the perfectly legal "a:". Sizing the field instead produced both errors at once -
 * a gate that passed a value the server rejects, and one that blocked a value it accepts.
 *
 * Empty in, empty out: an untouched field has nothing to report, and returning ":" for it would
 * manufacture a blank-segment complaint before the user has typed anything.
 */
export const submittedTagPrefix = (prefix: string | undefined | null): string => {
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  if (!trimmed) return '';
  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
};

/**
 * The reason a `fileTagPrefix` is unusable, as user-facing copy, or null when it is fine. Shared
 * by the wizard steps that can both edit a prefix so their wording cannot drift apart; the server
 * rejects all four cases at create.
 *
 * There is deliberately no MIN-length branch: the value judged here is the SUBMITTED one, and
 * appending ":" makes any positive-length entry at least 2 characters, so MIN cannot fail from
 * something the user typed. A bare ":" trips the blank-segment rule instead, and an empty field
 * stays silent so an untouched form reports nothing.
 */
export const tagPrefixIssue = (
  prefix: string | undefined | null,
  overlapping?: { name: string; fileTagPrefix: string } | null
): string | null => {
  // Length first, then blank-segment, then reserved - the schema's own order, since its
  // .min/.max run BEFORE its refines. So both surfaces name the same culprit for an input
  // that trips two rules (an over-long prefix ending "::" reads as too long on either side).
  // All of them judge the SUBMITTED form (see submittedTagPrefix), never the raw field.
  const submitted = submittedTagPrefix(prefix);
  if (submitted.length > MAX_TAG_PREFIX_LENGTH) {
    return `Tag prefix must be ${MAX_TAG_PREFIX_LENGTH} characters or fewer (this one is ${submitted.length}). Shorten it - every tag in the lake carries it.`;
  }
  if (submitted && hasBlankTagPrefixSegment(submitted)) {
    return 'Every ":" segment of the prefix needs a visible character (e.g. legal: or legal:contracts:).';
  }
  if (isReservedTagPrefix(submitted)) {
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
   * The passage size (TOKENS) this lake requires of its members, when it declares one. Editor-only,
   * same gate as the fields above, and surfaced so the settings form can seed the current value.
   *
   * ABSENT means the lake declares no target and inherits the platform default - which is not a
   * cosmetic difference: an explicit target is the sole trigger for convergence (epic decision 5),
   * so it is the difference between a lake that can be repaired toward its policy and one that is
   * only ever measured. Absent for a non-editor too, who never renders the field.
   */
  requiredPassageTokenTarget?: number;
  /**
   * Whether the requesting caller CREATED this lake (createdByUserId === caller). Server-computed
   * per request. The manager list is "lakes I can reach", not "lakes I own": it also surfaces org
   * lakes, strangers' public lakes, and - for a global admin - every tenant's lakes. So the UI
   * marks a not-own lake to keep an admin from mistaking someone else's (even private) lake for
   * their own and managing it by accident. Built-in fallback lakes have no owner, so `false`.
   *
   * REQUIRED, not optional: both producers (toManageableConfig, toFallbackConfig) set it
   * unconditionally, and the UI safety-gates on `isOwn === false` - an absent field would render
   * no warning, so a future projection that forgot it would silently reintroduce the bug with a
   * green typecheck. Required makes that a compile error instead.
   */
  isOwn: boolean;
  /**
   * Display name (name || username, never email) of the lake's creator. Populated ONLY for lakes
   * the caller does NOT own, and ONLY when the list projection was given a user lookup (the
   * manager list route) - the content-scope resolver and Slack omit it and pay for no extra
   * query. Mirrors the discover catalog's owner rule: never the owner's email, so a cross-org or
   * admin view can't leak an address. Undefined when the owner can't be resolved (deleted
   * account), or for own/fallback lakes.
   */
  ownerDisplayName?: string;
  /**
   * Preferred registry system-prompt id (see IDataLake.preferredSystemPromptId). EDITOR-ONLY,
   * like `systemPrompt`: surfaced only when the caller can manage the lake, so the settings
   * picker can seed its current selection. Absent (never an empty-string stand-in) otherwise,
   * so "not yours to see" and "no preferred prompt" stay distinguishable.
   */
  preferredSystemPromptId?: string;
  /**
   * How many proposals are waiting for this caller to review (#1671). EDITOR-ONLY, same gate as the
   * fields above: deciding what enters a lake is a management right, so a reader must not learn that
   * a queue exists, let alone how deep it is.
   *
   * Carried on the LIST rather than fetched per lake because it is the feature's only discovery
   * surface. Nothing else in the app says a human has work waiting - without this the queue is
   * reachable only by opening a lake's settings and noticing a tab that exists solely when it is
   * non-empty, which is not a signal anyone will find.
   *
   * Absent (never 0) when the caller cannot manage the lake or the projection was given no proposal
   * repo, so "none waiting" and "not yours to see" stay distinguishable.
   */
  pendingProposalCount?: number;
  /**
   * Per-lake grounding mode (see IDataLake.groundingMode). EDITOR-ONLY, like the two prompt fields:
   * surfaced only when the caller can manage the lake, so the settings picker can seed its current
   * selection. Absent when the caller can't manage it OR the lake never set the field (readers get
   * its EFFECT via the create-time resolver, never the setting itself).
   */
  groundingMode?: DataLakeGroundingMode;
  /**
   * Lifetime embedding-spend meter (see IDataLake.embeddingSpendMicroUsd). EDITOR-ONLY, same
   * gate as the fields above: a reader gets none of a lake's financial telemetry. ALWAYS present
   * (defaulted to 0, never omitted) when the caller can manage this lake, even with zero spend -
   * unlike the other editor-only fields above, its mere presence vs. absence is itself the
   * client's signal to show the spend view, so a manageable-but-unspent lake must not look
   * identical to a non-manageable one. `GET /api/data-lakes/:id/spend` independently re-checks
   * manage access as the real security boundary; this field only decides whether to show the tab.
   */
  embeddingSpendMicroUsd?: number;
  /**
   * Whether the requesting caller may REBUILD this lake's passages (re-chunk files already in
   * it). Narrower than `canManage` on purpose: a fallback (built-in) lake has no document to
   * mutate, so `canManage` is always false for it, but rebuild attaches nothing and mutates no
   * lake document - see `assertLakeRebuildAccess`. For a DB lake the two are identical
   * (`canRebuild === canManage`); for a fallback lake `canRebuild` is `ctx.isAdmin` while
   * `canManage` stays `false`. Kept as a SEPARATE flag rather than folded into `canManage` so the
   * client can gate the Rebuild affordance without also lighting up rename/delete/visibility/
   * file-removal, which would still fail server-side on a fallback lake.
   *
   * REQUIRED, not optional - same reasoning as `isOwn`: both producers (toManageableConfig,
   * toFallbackConfig) set it unconditionally, so an absent field is a compile error rather than a
   * silently-reintroduced gap FOR EVERY IN-REPO CALLER. That guarantee has two known exceptions
   * that TypeScript cannot see: a test fixture built via an `as ManageableDataLakeConfig` cast
   * (e.g. resolveManageableLake.test.ts), and the actual HTTP response at the wire boundary
   * (hooks/data/dataLakes.ts's `api.get<{ data: ManageableDataLakeConfig[] }>(...)`), which is
   * trusted with no runtime validation. Both fail CLOSED (an absent field reads as falsy, hiding
   * the affordance rather than exposing it), so this is a precision note, not a safety concern.
   */
  canRebuild: boolean;
  /**
   * Whether the requesting caller may edit this lake's admin-settable session-default OVERLAY
   * (currently `groundingMode` only - see `IFallbackLakeSetting`). Same shape as `canRebuild`, for
   * the same reason: a fallback (built-in) lake has no document, so `canManage` stays `false` for
   * it, but the overlay attaches to no lake document either - see
   * `assertFallbackLakeSettingsWriteAccess`. For a DB lake the two are identical
   * (`canManageSettings === canManage`, and a DB lake's settings live on the document itself, so
   * this flag gates nothing extra there); for a fallback lake `canManageSettings` is `ctx.isAdmin`
   * directly, NOT `resolveCanManageLake` - an org-scoped registry lake must not let a customer-side
   * org admin pass, mirroring `assertLakeRebuildAccess`'s reasoning exactly.
   *
   * REQUIRED, not optional - same reasoning as `canRebuild`: both producers (toManageableConfig,
   * toFallbackConfig) must set it unconditionally, or an absent field silently hides the affordance
   * (fails closed) rather than surfacing a compile error at the one spot that forgot it.
   */
  canManageSettings: boolean;
}

/**
 * A public data lake as it appears in the discover/browse surface: the lightweight card
 * projection returned by the `/api/data-lakes/public` browse endpoint. Distinct from
 * DataLakeConfig - it drops the access/gate internals (the endpoint has already resolved the
 * gate for this caller) and adds the human-facing preview metadata the catalog renders: owner
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
  // ASSUMPTION, unenforced at load time: no two entries here (including this one) may have
  // overlapping fileTagPrefix values (e.g. 'opti:' and 'opti:legal:'). openLakeTagPrefix's callers
  // (grantingLakes, attributeAccessedLakeIds) each independently reverse a prefix match back to
  // ONE lake with no exclusivity check between lakes - an overlap would let a single file's
  // content-tag satisfy two lakes' prefixes at once, over-attributing/over-granting to both. A
  // dynamic (DB) lake is checked against this list at creation time (collidesWithRegistryPrefix in
  // createDataLake.ts); nothing checks entries within this list against each other.
  ...PREMIUM_DATA_LAKES,
];

/** Static-registry lake ids - see `openLakeTagPrefix`'s doc comment for what this set decides. */
export const STATIC_LAKE_IDS = new Set(DATA_LAKES.map(l => l.id));

/**
 * A lake's normalized file-tag prefix, but ONLY if the lake is in the static registry
 * (`STATIC_LAKE_IDS`) - `undefined` for a dynamic (user-created) lake's prefix, which is
 * user-controlled and can collide across tenants, so it is never usable as a standalone grant or
 * attribution signal on its own; or for a static lake with no usable prefix at all.
 *
 * The shared place "is this lake's prefix an OPEN one" is decided BY ID MEMBERSHIP in the static
 * registry, so every consumer that reverses a content-tag-prefix match back to a specific lake -
 * `grantingLakes`/`isFileInAccessibleLake` (`apps/client/server/dataLakes/grantingLakes.ts`,
 * naming the grantor of a single already-authorized file), `splitTagPrefixes` (same file's
 * barrel, scoping a browse/search query), and `attributeAccessedLakeIds`
 * (`b4m-core/services/src/dataLakeService/attributeAccessedLakes.ts`, naming the lake a retrieved
 * file's content actually came from) - agrees on the same answer. Two independently-normalized
 * copies of this predicate have drifted before (a padded prefix passed create validation but
 * mismatched between the ownership arm and the tag counter); one shared computation is what keeps
 * that class of bug from recurring in THOSE consumers.
 *
 * NOT the right predicate everywhere open/dynamic provenance matters, though: id-membership
 * answers "is this id in the hardcoded list", not "did this lake come from the DB". A DB row can
 * shadow a registry id, and there the two answers diverge - see `getDynamicDataLakeTags.ts`'s
 * `dynamicIds`, which classifies by source for exactly that reason and must not be replaced with
 * this function.
 */
export function openLakeTagPrefix(lake: { id: string; fileTagPrefix?: string | null }): string | undefined {
  if (!STATIC_LAKE_IDS.has(lake.id)) return undefined;
  return normalizeTagPrefix(lake.fileTagPrefix) ?? undefined;
}

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
