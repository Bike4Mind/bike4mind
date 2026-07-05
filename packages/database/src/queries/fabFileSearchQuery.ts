import { CODE_FILE_MIME_TYPES } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { USE_DOCUMENTDB } from '../utils/documentdb-compat';

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
  type: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code'
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
     * SCOPED tag prefixes - DYNAMIC (user-created) lakes. Their `fileTagPrefix` is
     * user-controlled and unreserved, so two users/orgs can pick the same prefix. A
     * prefix match here is therefore ANDed with owner/org/shared access so a colliding
     * prefix can never read another tenant's files.
     */
    scopedTagPrefixes?: string[];
    /**
     * Restrict results to the lake(s) named by `dataLakeTags`/`scopedTagPrefixes` only -
     * omit the broad owner/shared/group arms that otherwise return ALL of the user's files.
     * Single-lake views (GET /api/data-lakes/:id/articles) set this so one lake's browser
     * shows only that lake's files, not every file the user owns (other lakes' files
     * were bleeding into every lake's "Uncategorized"). Lake access is verified upstream
     * (assertLakeAccess), so matching the unique meta-tag without the ownership arms is safe.
     */
    restrictToDataLake?: boolean;
  }
): object[] {
  // Base access: the file genuinely belongs to / is shared with this user. Reused both
  // as top-level $or arms and to scope the dynamic-lake prefix match.
  const baseAccess: object[] = [
    { userId }, // Files owned by user
    {
      // Files explicitly shared with user
      users: {
        $elemMatch: {
          userId,
          permissions: { $in: ['read', 'write'] },
        },
      },
    },
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

  const validPrefixes = (prefixes: string[] | undefined) =>
    (prefixes ?? []).map(p => p.trim()).filter(p => p.length > 0 && p.endsWith(':'));

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

  // SCOPED prefix arm (dynamic lakes) - prefix match ANDed with base access, so a
  // user-chosen prefix colliding with another tenant's tags can never bypass ownership.
  const scopedPrefixes = validPrefixes(options?.scopedTagPrefixes);
  if (scopedPrefixes.length > 0) {
    const prefixPattern = scopedPrefixes.map(p => escapeRegex(p)).join('|');
    conditions.push({
      $and: [{ tags: { $elemMatch: { name: { $regex: new RegExp(`^(${prefixPattern})`) } } } }, { $or: baseAccess }],
    });
  }

  // Guard the footgun: in lake-scoped mode we drop the broad ownership arms, so if the
  // caller set restrictToDataLake but supplied no lake tag/prefix arm, `conditions` is
  // empty and downstream would build `{ $or: [] }` - which MongoDB rejects at query time
  // ($or must be a non-empty array). Fail fast here with a descriptive error instead.
  if (options?.restrictToDataLake && conditions.length === 0) {
    throw new Error(
      'buildOwnershipConditions: restrictToDataLake requires at least one of dataLakeTags or scopedTagPrefixes'
    );
  }

  return conditions;
}

export type FabFileFilterType =
  | 'text'
  | 'pdf'
  | 'url'
  | 'image'
  | 'excel'
  | 'word'
  | 'json'
  | 'csv'
  | 'markdown'
  | 'code';

export interface FabFileSearchParams {
  userId: string;
  search: string;
  filters: {
    tags?: string[];
    type?: FabFileFilterType;
    shared?: boolean;
    curated?: boolean;
    fileIds?: string[];
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
    /** Dynamic (owner/org-scoped) lake prefixes - see buildOwnershipConditions. */
    scopedTagPrefixes?: string[];
    /** Single-lake view: return only this lake's files, not all owned files - see buildOwnershipConditions. */
    restrictToDataLake?: boolean;
    excludeContent?: boolean;
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

  // Tag filter
  if (filters.tags && filters.tags.length > 0) {
    andConditions.push({
      tags: { $elemMatch: { name: { $in: filters.tags.map(tag => new RegExp(escapeRegex(String(tag)), 'i')) } } },
    });
  }

  // File ID exclusion filter
  if (filters.fileIds && filters.fileIds.length > 0) {
    baseFilter._id = { $nin: filters.fileIds };
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
  } else if (options?.includeShared === true) {
    const ownershipConds = buildOwnershipConditions(userId, {
      userGroups: options.userGroups,
      dataLakeTags: options.dataLakeTags,
      dataLakeTagPrefixes: options.dataLakeTagPrefixes,
      scopedTagPrefixes: options.scopedTagPrefixes,
      restrictToDataLake: options.restrictToDataLake,
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

  // Exclude session summaries (but allow curated notebooks)
  andConditions.push({
    $or: [
      { sessionId: { $eq: null } },
      { sessionId: { $exists: false } },
      { tags: { $elemMatch: { name: 'curated-notebook' } } },
    ],
  });

  // Assemble final filter
  const filter: Record<string, unknown> = { ...baseFilter };
  if (andConditions.length > 0) {
    filter.$and = andConditions;
  }

  // Sort - DocumentDB uses lowercase field for case-insensitive sorting
  let sort: Record<string, 1 | -1>;
  if (order.by === 'fileName' && useDocumentDB) {
    sort = { fileNameLower: order.direction === 'asc' ? 1 : -1 };
  } else {
    sort = { [order.by]: order.direction === 'asc' ? 1 : -1 };
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
