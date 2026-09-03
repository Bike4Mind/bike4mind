import {
  CHUNK_STALL_REASONS,
  CODE_FILE_MIME_TYPES,
  LEGACY_CHUNK_STALL_NOTES,
  normalizeTagPrefix,
  type DataLakeMembershipScope,
} from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { buildFilenameMarkerRegex } from '@bike4mind/utils/retrievalExclusion';
import { USE_DOCUMENTDB } from '../utils/documentdb-compat';
import { buildDataLakeMembershipFilter, buildLacksContentPrefixTagFilter } from './dataLakeLifecycleScope';

/**
 * Stop words filtered out during text search to improve match quality.
 * Natural-language queries like "Acme vs Globex competitive positioning"
 * should match files containing significant terms, not common words.
 */
export const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'and',
  'or',
  'but',
  'if',
  'so',
  'than',
  'too',
  'very',
  'not',
  'no',
  'nor',
  'vs',
  'versus',
  'about',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'they',
  'them',
  'his',
  'her',
  'their',
  'give',
  'get',
  'got',
  'let',
  'make',
  'how',
  'what',
  'which',
  'who',
  'when',
  'where',
  'why',
]);

/**
 * Escape regex special characters to prevent invalid MongoDB regex errors and
 * regex injection / ReDoS. Re-exported from the shared `@bike4mind/utils`
 * implementation so existing `import { escapeRegex } from './fabFileSearchQuery'`
 * call sites keep working.
 */
export { escapeRegex };

/** Map file type filter to MongoDB mimeType query condition */
export function getMimeTypeFilter(
  type: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio'
): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { mimeType: 'text/plain' };
    case 'pdf':
      return { mimeType: 'application/pdf' };
    case 'url':
      return { type: 'URL' };
    case 'image':
      return { mimeType: { $regex: '^image/' } };
    case 'excel':
      return {
        mimeType: {
          $in: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        },
      };
    case 'word':
      return { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    case 'json':
      return { mimeType: 'application/json' };
    case 'csv':
      return { mimeType: 'text/csv' };
    case 'markdown':
      return { mimeType: 'text/markdown' };
    case 'code':
      return { mimeType: { $in: CODE_FILE_MIME_TYPES } };
    case 'audio':
      return { mimeType: { $regex: '^audio/' } };
  }
}

/**
 * Build ownership conditions for file access control.
 * Returns an array of $or conditions covering: owned, shared, group-shared, and data-lake access.
 */
export function buildOwnershipConditions(
  userId: string,
  options?: {
    userGroups?: string[];
    dataLakeTags?: string[];
    /**
     * OPEN tag prefixes - the STATIC registry lakes (e.g. `opti:`, `acme:`): shared
     * knowledge-base content, access-gated at the endpoint and intentionally readable
     * by any entitled user, so a prefix match here is an ownership bypass (by design).
     * MUST only ever be sourced from the hardcoded `DATA_LAKES` registry - never from a
     * user-supplied `fileTagPrefix`.
     */
    dataLakeTagPrefixes?: string[];
    /**
     * Restrict results to the lake(s) named by `dataLakeTags`/`lakeMemberships` only -
     * omit the broad owner/shared/group arms that otherwise return ALL of the user's files.
     * Single-lake views (GET /api/data-lakes/:id/articles) set this so one lake's browser
     * shows only that lake's files, not every file the user owns (other lakes' files
     * were bleeding into every lake's "Uncategorized"). Lake access is verified upstream
     * (assertLakeAccess), so matching the unique meta-tag without the ownership arms is safe.
     */
    restrictToDataLake?: boolean;
    /**
     * One arm per accessible lake's membership scope - the SAME predicate the whole-lake writes
     * use, so any caller of this builder (the single-lake browse, and retrieval) lists/matches
     * exactly what an archive or a permanent delete would act on. Each arm's prefix is anchored
     * to THAT lake's CREATOR, not the viewer: a
     * viewer's own file that merely happens to carry a colliding tag prefix is not a member of
     * someone else's lake, and a per-viewer answer could never agree with the lake's persisted
     * fileCount.
     *
     * Server-supplied only, never from request input. An `owned` scope carries a `creatorUserId`
     * that widens what the query matches, so a value reaching this from request input would let a
     * caller name any user and read their files - keep it out of every parsed-input surface.
     *
     * A `registry` scope's prefix arm carries NO ownership conjunct (see
     * `buildDataLakeMembershipFilter`), so it is safe ONLY where access is gated upstream and the
     * query covers ONE lake - today that is the single-lake browse (`data-lakes/[id]/articles.ts`,
     * gated by `assertLakeAccess`). Never put one in a multi-lake retrieval query: an unanchored
     * prefix arm beside other lakes' arms is the cross-tenant promotion the SCOPED/OPEN split
     * forbids. `lakeMembershipsFrom` filters `registry` out for that reason, but it is NOT the only
     * door - `knowledgeBaseCount` reads `ResolvedLakeAccess.membership` directly. What actually
     * holds the invariant is that `membership` is only ever attached to dynamic lakes; the filter
     * is the second guard, not the first.
     */
    lakeMemberships?: DataLakeMembershipScope[];
    /**
     * Drop the "shared 1:1 with this user" arm from base access, keeping owned + group +
     * data-lake arms, for the per-user WORKSPACES tag/namespace count only (GET
     * /api/files/tags/counts opts in; GET /api/files/tags does not - see userFileScope.ts).
     *
     * The write paths that keep a tag's denormalized name in sync (removeTagByUserId,
     * updateTagsByUserId) only ever touch files the user owns, so a tag string surviving solely
     * on a file merely shared with them can never be cleared by renaming/deleting their own tag -
     * it keeps counting as an orphan bucket (the bug this flag fixes).
     *
     * That reconciliation argument is EQUALLY true of a group-shared or data-lake file owned by
     * someone else - the write paths can't fix those either. Group/data-lake access stays IN as
     * a deliberate product choice (they are the user's own persistent, subscribed-to workspaces,
     * not an incidental share), not because it is more reconcilable. The group/data-lake orphan
     * case this does not cover is a known, accepted gap. If revisited, the two options are
     * extending this same narrowing to the group/data-lake arms, or leaving it as accepted
     * behavior (the choice made here).
     */
    excludePersonalShares?: boolean;
  }
): object[] {
  // Base access: the file genuinely belongs to / is shared with this user. Reused both
  // as top-level $or arms and to scope the dynamic-lake prefix match.
  const baseAccess: object[] = [
    { userId }, // Files owned by user
    ...(options?.excludePersonalShares
      ? []
      : [
          {
            // Files explicitly shared with user
            users: {
              $elemMatch: {
                userId,
                permissions: { $in: ['read', 'write'] },
              },
            },
          },
        ]),
  ];

  // Add group-level sharing if user has groups (organization sharing)
  if (options?.userGroups && options.userGroups.length > 0) {
    baseAccess.push({
      groups: {
        $elemMatch: {
          groupId: { $in: options.userGroups },
          permissions: { $in: ['read', 'write'] },
        },
      },
    });
  }

  // In lake-scoped mode, start with NO broad ownership arms - only the lake tag/prefix arms
  // below select files, so a single-lake view can't fall back to "all files the user owns".
  const conditions: object[] = options?.restrictToDataLake ? [] : [...baseAccess];

  // One arm per lake. An `owned` scope ANDs THAT lake's prefix with THAT lake's creator, never the
  // caller's, so a colliding prefix can't cross a tenant boundary; a `registry` scope's prefix arm
  // is unanchored by design and is only ever supplied on the access-gated single-lake browse (see
  // the `lakeMemberships` docblock). Same predicate the browse, health, archive and permanent
  // delete run on - drift between them is what #2243 was.
  for (const scope of options?.lakeMemberships ?? []) {
    conditions.push(buildDataLakeMembershipFilter(scope));
  }

  // Shared with the single-file removal write path (see normalizeTagPrefix): the prefixes
  // matched here are exactly the ones a removal is allowed to clear.
  const validPrefixes = (prefixes: string[] | undefined) =>
    (prefixes ?? []).map(normalizeTagPrefix).filter((p): p is string => p !== null);

  // Include data lake files accessible to this user (by exact meta-tag). The meta-tag
  // (`datalake:<org>:<slug>`) is uniquely namespaced and the accessible set is resolved
  // upstream, so matching it is a SAFE ownership bypass (can't collide across tenants).
  if (options?.dataLakeTags && options.dataLakeTags.length > 0) {
    conditions.push({
      tags: {
        $elemMatch: {
          name: { $in: options.dataLakeTags },
        },
      },
    });
  }

  // OPEN prefix arm (static registry) - bypasses ownership, by design (shared KB).
  const openPrefixes = validPrefixes(options?.dataLakeTagPrefixes);
  if (openPrefixes.length > 0) {
    const prefixPattern = openPrefixes.map(p => escapeRegex(p)).join('|');
    conditions.push({
      tags: {
        $elemMatch: {
          name: { $regex: new RegExp(`^(${prefixPattern})`) },
        },
      },
    });
  }

  // Guard the footgun: in lake-scoped mode we drop the broad ownership arms, so if the
  // caller set restrictToDataLake but supplied no lake tag/prefix arm, `conditions` is
  // empty and downstream would build `{ $or: [] }` - which MongoDB rejects at query time
  // ($or must be a non-empty array). Fail fast here with a descriptive error instead.
  if (options?.restrictToDataLake && conditions.length === 0) {
    throw new Error(
      'buildOwnershipConditions: restrictToDataLake requires lakeMemberships, dataLakeTags or dataLakeTagPrefixes'
    );
  }

  return conditions;
}

export type FabFileFilterType =
  'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio';

export interface FabFileSearchParams {
  userId: string;
  search: string;
  filters: {
    tags?: string[];
    type?: FabFileFilterType;
    shared?: boolean;
    curated?: boolean;
    fileIds?: string[];
    /**
     * File-id ALLOW-list (contrast fileIds above, which EXCLUDES). Fail-closed contract:
     * undefined = no restriction; present (including []) = results restricted to these ids,
     * and an empty array matches nothing. Never client-supplied - derived server-side
     * (e.g. a project's file set or an agent's KB scope).
     */
    restrictToFileIds?: string[];
  };
  pagination: { page: number; limit: number };
  order: { by: 'createdAt' | 'fileName' | 'fileSize'; direction: 'asc' | 'desc' };
  options?: {
    textSearch?: boolean;
    includeShared?: boolean;
    userGroups?: string[];
    dataLakeTags?: string[];
    /** Static-registry (open) lake prefixes - see buildOwnershipConditions. */
    dataLakeTagPrefixes?: string[];
    /** Server-supplied only - see buildOwnershipConditions.lakeMemberships. */
    lakeMemberships?: DataLakeMembershipScope[];
    /** Single-lake view: return only this lake's files, not all owned files - see buildOwnershipConditions. */
    restrictToDataLake?: boolean;
    /**
     * Treat the restrictToFileIds allow-list as the SOLE authorization: skip the
     * ownership/sharing predicate entirely, so files curated into a server-resolved
     * scope match even when owned by another user (curation is the grant - the KB
     * scoped arms' contract, mirroring getAccessibleFiles on the semantic side).
     * Ignored unless restrictToFileIds is present, so it can never widen an
     * unrestricted search.
     */
    skipOwnership?: boolean;
    excludeContent?: boolean;
    /**
     * Generic retrieval-exclusion: keep documents whose filename begins with one of these
     * markers (case-insensitive, WORD-BOUNDARY anchored - not a bare prefix) out of results,
     * so retrieval agrees with a product surface's document-listing predicate. Unset/empty/
     * whitespace-only is a byte-identical no-op. See @bike4mind/utils/retrievalExclusion.
     */
    excludeFilenameMarkers?: string[];
    /** When true, restrict results to vectorized files only (excludes unvectorized). */
    vectorizedOnly?: boolean;
    /**
     * Narrow to the files carrying NO tag under ANY of these lake prefixes - what the browse
     * surfaces render as an "Uncategorized" bucket. One prefix for a single-lake browser; the
     * whole accessible set for a MERGED tree, where a file categorized under any one lake is
     * reachable through that lake's branch and only a file categorized under none of them is
     * invisible.
     *
     * NARROWING only, ANDed above the access arms: it never widens the scope. It must therefore
     * be paired with `restrictToDataLake`, or it returns every non-lake file the caller owns
     * that happens to lack these prefixes.
     *
     * Built by `buildLacksContentPrefixTagFilter`, so the bucket holds exactly the files the
     * write-door reconciler and the backfill migration consider uncategorized. Unusable and
     * duplicate prefixes are dropped rather than matching everything / repeating a conjunct.
     */
    lacksContentPrefixTags?: string[];
  };
  useDocumentDB?: boolean;
}

export interface FabFileSearchQuery {
  filter: Record<string, unknown>;
  sort: Record<string, 1 | -1>;
  collation: { locale: string } | null;
  skip: number;
  limit: number;
  excludeContent?: boolean;
}

/**
 * Builds a MongoDB filter object from business parameters.
 * Pure function - no DB calls, no side effects.
 * Handles: stop-words, MIME mapping, regex escaping, ownership conditions,
 *          DocumentDB compat, session-summary exclusion.
 */
export function buildFabFileSearchQuery(params: FabFileSearchParams): FabFileSearchQuery {
  const { userId, search, filters, pagination, order, options } = params;
  const useDocumentDB = params.useDocumentDB ?? USE_DOCUMENTDB();

  // archivedAt: null excludes files whose data lake is archived (matches null AND
  // missing, so non-data-lake files are unaffected). Keeps archived lake content out
  // of search/RAG retrieval - the read-path half of "archive hides files".
  const baseFilter: Record<string, unknown> = { deletedAt: null, archivedAt: null };
  const andConditions: object[] = [];

  // Text search / filename search
  if (search) {
    if (options?.textSearch) {
      const terms = search
        .split(/\s+/)
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t.toLowerCase()))
        .map(escapeRegex);

      if (terms.length > 0) {
        const fieldConditions: object[] = [];
        for (const term of terms) {
          const termRegex = { $regex: term, $options: 'i' };
          fieldConditions.push({ fileName: termRegex }, { 'tags.name': termRegex }, { notes: termRegex });
        }
        andConditions.push({ $or: fieldConditions });
      }
    } else {
      baseFilter.fileName = { $regex: escapeRegex(search), $options: 'i' };
    }
  }

  // Tag filter. Anchored: these are whole tag names picked from the user's tag list, not a search
  // term, so filtering by `test` must not also return files tagged `testing`. Unanchored, this
  // disagreed with countFilesByTagForUser, which groups on the exact stored name - so the badge and
  // the list it is compared against could cover different files.
  if (filters.tags && filters.tags.length > 0) {
    andConditions.push({
      tags: {
        $elemMatch: { name: { $in: filters.tags.map(tag => new RegExp(`^${escapeRegex(String(tag))}$`, 'i')) } },
      },
    });
  }

  // File ID exclusion filter
  if (filters.fileIds && filters.fileIds.length > 0) {
    baseFilter._id = { $nin: filters.fileIds };
  }

  // File ID allow-list (restriction). Deliberately NO length guard: presence of the field -
  // even as [] - means "restrict", and { $in: [] } matches nothing (fail-closed empty scope).
  // Merges with the exclusion above so both apply (a file must be in $in AND not in $nin).
  if (filters.restrictToFileIds !== undefined) {
    const existing = (baseFilter._id as Record<string, unknown> | undefined) ?? {};
    baseFilter._id = { ...existing, $in: filters.restrictToFileIds };
  }

  // MIME type filter
  if (filters.type) {
    Object.assign(baseFilter, getMimeTypeFilter(filters.type));
  }

  // Ownership / sharing / access control
  if (filters.shared === true) {
    baseFilter.userId = { $ne: userId };
    baseFilter.users = {
      $elemMatch: {
        userId,
        permissions: { $in: ['read', 'write'] },
      },
    };
  } else if (filters.curated === true) {
    baseFilter.userId = userId;
    andConditions.push({
      tags: { $elemMatch: { name: 'curated-notebook' } },
    });
  } else if (options?.skipOwnership === true && filters.restrictToFileIds !== undefined) {
    // Allow-list-as-authority: no ownership predicate. Only reachable with a present
    // restrictToFileIds (see the option's doc), so results are still hard-bounded to
    // the server-resolved id set composed above.
  } else if (options?.includeShared === true) {
    const ownershipConds = buildOwnershipConditions(userId, {
      userGroups: options.userGroups,
      dataLakeTags: options.dataLakeTags,
      dataLakeTagPrefixes: options.dataLakeTagPrefixes,
      restrictToDataLake: options.restrictToDataLake,
      lakeMemberships: options.lakeMemberships,
    });
    andConditions.push({ $or: ownershipConds });
  } else {
    baseFilter.userId = userId;
  }

  // File size filter (ensure field exists when sorting by fileSize)
  if (order.by === 'fileSize') {
    andConditions.push({
      $or: [{ fileSize: { $exists: true, $ne: null } }, { fileSize: 0 }],
    });
  }

  // Uncategorized bucket (opt-in): the members carrying no tag under any of these lake prefixes.
  // Each prefix is its own $and clause rather than merged or spread onto baseFilter - every
  // fragment's top-level key is `tags`, which the tag filter above and the session-summary clause
  // below also name, so combining them any other way would silently drop all but the last.
  const lacksPrefixes = [
    ...new Set((options?.lacksContentPrefixTags ?? []).map(normalizeTagPrefix).filter((p): p is string => p !== null)),
  ];
  for (const prefix of lacksPrefixes) {
    andConditions.push(buildLacksContentPrefixTagFilter(prefix));
  }

  // Exclude session summaries (but allow curated notebooks)
  andConditions.push({
    $or: [
      { sessionId: { $eq: null } },
      { sessionId: { $exists: false } },
      { tags: { $elemMatch: { name: 'curated-notebook' } } },
    ],
  });

  // Generic retrieval exclusion (opt-in): drop unvectorized files and/or files whose name
  // begins with a caller-supplied marker, so RAG retrieval agrees with the caller's listing
  // predicate. Pushed as $and clauses (never Object.assign onto baseFilter, which would clobber
  // baseFilter.fileName for the plain-search path). Both are no-ops when unset - an empty
  // marker set yields a null regex (buildFilenameMarkerRegex), so today's queries are unchanged.
  if (options?.vectorizedOnly) {
    // Same exemption, same reason, as `isRetrievalExcluded`'s in-memory arm - and it has to be here
    // too, or the file is dropped by the DB before the authoritative post-filter can spare it. A
    // member the convergence kill switch stalled is unvectorized because its content was taken away;
    // it must reach `partitionByIndexAvailability` to be withheld and REPORTED rather than silently
    // absent. `$in` over CHUNK_STALL_REASONS so this covers EITHER arm and cannot drift from
    // `isChunkStalled`, which the in-memory arm now calls. Keep the two in sync.
    //
    // Third arm: a REQUESTED-but-uncommitted rebuild (#1939). The reset writes `vectorized: false`
    // and clears the stall reason together, so between it and the consumer's marker there is nothing
    // for the arm above to match and the row was dropped here, before the post-filter or the withhold
    // could report it. `$ne: null` also excludes a missing field, so this matches only rows carrying a
    // real stamp.
    andConditions.push({
      $or: [
        { vectorized: true },
        { chunkStallReason: { $in: [...CHUNK_STALL_REASONS] } },
        // Transitional fourth arm, the Mongo mirror of `isChunkStalledFile`: rows #2016's migration
        // has not reached yet still carry the marker as prose in `notes` and no `chunkStallReason`.
        // The queue stack does not wait on the migrator, so it can run this query against them.
        // Delete with the in-memory arm, one release after the migration has landed everywhere.
        { notes: { $in: [...LEGACY_CHUNK_STALL_NOTES] } },
        { chunkRebuildRequestedAt: { $ne: null } },
      ],
    });
  }
  // Matched against the pre-lowered, indexed `fileNameLower` (no $options:'i' - index-safe).
  const markerRegex = buildFilenameMarkerRegex(options?.excludeFilenameMarkers);
  if (markerRegex) {
    andConditions.push({ fileNameLower: { $not: markerRegex } });
  }

  // Assemble final filter
  const filter: Record<string, unknown> = { ...baseFilter };
  if (andConditions.length > 0) {
    filter.$and = andConditions;
  }

  // Sort - DocumentDB uses lowercase field for case-insensitive sorting
  const direction = order.direction === 'asc' ? 1 : -1;
  let sort: Record<string, 1 | -1>;
  if (order.by === 'fileName' && useDocumentDB) {
    sort = { fileNameLower: direction };
  } else {
    sort = { [order.by]: direction };
  }
  // Neither `fileName` nor `fileSize` is unique - a lake legitimately holds duplicate uploads, and
  // byte-identical ones tie on both - so skip-paginating either can drop or repeat a file at a page
  // boundary. The `_id` tiebreaker makes them a total order. Unconditional rather than opt-in: this
  // was an opt-in and four listing callers silently did not take it.
  // Free on every path for these two: FabFileSchema declares no `fileName` and no `fileSize` index,
  // so each is already an unavoidable blocking sort. The one real cost is `fileName` on the
  // DocumentDB branch, which gives up the addLowercaseField plugin's `{fileNameLower: 1}` index -
  // taken deliberately, since this find path sets no allowDiskUse (FabFileModel.executeSearch) and
  // a silently short page is worse than a costly one.
  // `createdAt` is the third key this builder accepts and is deliberately EXCLUDED, on measurement
  // rather than assumption: no lake with tied values is known, and it is the only sort key with
  // indexes to lose. If a tied population is ever demonstrated, the remedy is this same line.
  if (order.by === 'fileName' || order.by === 'fileSize') {
    sort._id = direction;
  }

  return {
    filter,
    sort,
    collation: useDocumentDB ? null : { locale: 'en' },
    skip: (pagination.page - 1) * pagination.limit,
    limit: pagination.limit + 1, // +1 for hasMore detection
    excludeContent: options?.excludeContent,
  };
}
