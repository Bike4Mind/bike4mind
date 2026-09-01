/**
 * Data Lakes server module - shared lake-scope resolution for the BROWSE surfaces
 * (articles, tag-counts, and the rlm-answer access gate). Content is scoped by the lakes a
 * caller can access - files tagged with a lake's `datalakeTag` / `fileTagPrefix` - and access
 * is defined per-lake (`requiredUserTag`/`requiredEntitlement`), not per-product.
 *
 * The RETRIEVAL surface (semantic-search) resolves scope separately, through
 * ./resolveRetrievalLakeScope, so it shares the core resolver with the chat
 * search_knowledge_base tool. Browse is the WIDER of the two; two known differences, both in
 * that direction:
 *  - admin: browse returns `listAllDataLakes` - every lake of every tenant - while retrieval
 *    gives an admin the static registry plus only the lakes they reach unprivileged.
 *  - draft lakes: browse includes `draft`, retrieval is `active`-only.
 * So a caller can browse a lake that semantic search will not reach; never the reverse.
 * (An owner's own gated lake used to be a third difference - the retrieval resolver now
 * restores it, so both surfaces agree.)
 */
import {
  DATA_LAKES,
  STATIC_LAKE_IDS,
  getAccessibleDataLakes,
  hasDeveloperUserTag,
  isImageServeable,
} from '@bike4mind/common';
import type { DataLakeConfig, DataLakeMembershipScope } from '@bike4mind/common';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import type { EntitlementRequest } from '@server/entitlements';
import { getFilesStorage } from '@server/utils/storage';
import { toAccessContext } from './toAccessContext';
import { grantingLakes, isFileInAccessibleLake, normalizedLakePrefix } from './grantingLakes';
import { firstQueryValue } from './firstQueryValue';

export { grantingLakes, isFileInAccessibleLake, firstQueryValue };

/**
 * Resolve the data lakes a user can browse: their dynamic (DB) lakes - already
 * access-filtered by owner/org/tag inside `listDataLakes` - merged with the static
 * registry lakes they're entitled to. A dynamic lake shadows a same-id static one.
 *
 * Dynamic lakes are deliberately NOT re-filtered through `getAccessibleDataLakes`:
 * the service already authorized them (including owner access), and re-applying the
 * tag/entitlement filter would hide an owner's OWN lake whose `requiredUserTag` they
 * happen not to carry. Static lakes (no owner concept) still go through that filter.
 * The retrieval resolver does run that filter and compensates with its own owner re-check
 * (see getDynamicDataLakeAccess) - so if the two are ever unified, ownership must survive.
 *
 * Returns `DataLakeConfig[]`, not the manageable projection: the dynamic half carries the
 * `canManage`/`isOwn` labels but the static half does not, and every caller here (article,
 * tag-count, and answer scoping) reads only id/tag/prefix - never a manage field. Typing the
 * mixed result as the narrower shared shape keeps the manager-only labels off a path that has
 * no use for them.
 */
export async function resolveAccessibleLakes(req: EntitlementRequest): Promise<DataLakeConfig[]> {
  // toAccessContext, not a local literal: it is the one place this shape is built, and it is
  // what resolves entitlementKeys. Building it inline here silently dropped them, so
  // findAccessible saw no entitlement arm and browse lost a lake gated by requiredEntitlement
  // alone - which retrieval kept. Memoized per request, and skipped entirely for admins.
  // Costs a developer-tagged non-admin one subscription read they previously skipped: the old
  // inline form resolved keys lazily and that branch short-circuits on the developer tag. Worth
  // it to stop the two halves of the merge disagreeing about what the caller holds.
  const ctx = await toAccessContext(req);

  // No `users` adapter: this is the content-scope path (article/tag-count/answer gating), which
  // never renders an owner, so it must not pay for the owner-name lookup the manager list does.
  const dynamic = ctx.isAdmin
    ? await dataLakeService.listAllDataLakes(ctx, { db: { dataLakes: dataLakeRepository } })
    : await dataLakeService.listDataLakes(ctx, { db: { dataLakes: dataLakeRepository } });

  // Admin/developer see every static lake; everyone else is scoped by the any-of
  // requiredUserTag/requiredEntitlement filter, reusing the keys toAccessContext already
  // resolved so the static filter and the DB filter above cannot disagree about them.
  const staticLakes =
    ctx.isAdmin || hasDeveloperUserTag(ctx.userTags)
      ? DATA_LAKES
      : getAccessibleDataLakes(ctx.userTags, undefined, ctx.entitlementKeys);

  const dynamicIds = new Set(dynamic.map(d => d.id));
  return [...dynamic, ...staticLakes.filter(s => !dynamicIds.has(s.id))];
}

export interface DataLakeArticlesQuery {
  // `string[]` for the same reason as `tags`/`search` below: /api/data-lakes/articles has no `[id]`
  // route segment, so `id` comes purely from the query string and is repeatable.
  id?: string | string[];
  tags?: string | string[];
  search?: string | string[];
  page?: string;
  limit?: string;
  sortBy?: string;
  sortDir?: string;
}

/**
 * Split the accessible lakes' file-tag prefixes by provenance:
 *  - OPEN - static-registry lakes (opti:): shared KB, ownership-bypass by design.
 *  - SCOPED - dynamic (user-created) lakes: prefix is user-controlled and must never be
 *    promoted into an ownership bypass. Gating a dynamic-lake file is `lakeMemberships`'
 *    job now (each arm anchored to that lake's CREATOR - see buildLakeMembershipScopes); this
 *    split feeds only the tag tree's positional regex-grouping list (`allPrefixes` below).
 * The unique `datalakeTag` (exact match, never a prefix) safely covers every lake.
 *
 * Normalized through `normalizeTagPrefix` - the same predicate `buildDataLakeMembershipFilter`
 * applies - because the tag-count aggregates build their regex straight from what we return
 * here. Handing them the raw field let the two disagree: a lake stored with a padded prefix
 * (` a:` passes create validation, which never trims) matched `^(a:)` in the membership arm
 * but `^( a:)` in the counter, so its files were browsable yet counted zero. An unusable
 * prefix drops out entirely rather than reaching a regex as an empty alternation.
 */
function splitTagPrefixes(lakes: DataLakeConfig[]): { openTagPrefixes: string[]; scopedTagPrefixes: string[] } {
  const openTagPrefixes: string[] = [];
  const scopedTagPrefixes: string[] = [];
  for (const lake of lakes) {
    const normalized = normalizedLakePrefix(lake);
    if (!normalized) continue;
    (normalized.isOpen ? openTagPrefixes : scopedTagPrefixes).push(normalized.prefix);
  }
  return { openTagPrefixes, scopedTagPrefixes };
}

/**
 * One membership scope per lake, anchored to THAT lake's creator - the same predicate the
 * single-lake browse, health, archive and permanent delete run on. `DataLakeConfig` (what both
 * browse surfaces receive) carries no owner id, so the creator has to come from a batched DB
 * read rather than the config itself.
 *
 * A lake in the hardcoded registry takes the `registry` scope (meta-tag OR its compile-time
 * prefix, no ownership arm) instead. Doc-less and not in the registry should be unreachable
 * (every dynamic entry is derived from a document) but fails closed to meta-tag-only rather than
 * dropping the lake's key from the result, so an anomaly is visible instead of silently absent.
 *
 * ONE batched read, never one per lake: an admin's lake set is every lake of every tenant, and a
 * per-lake fan-out would issue that many concurrent findOnes against a pool of two.
 */
async function buildLakeMembershipScopes(
  lakes: DataLakeConfig[],
  dataLakeTags: string[]
): Promise<DataLakeMembershipScope[]> {
  const lakeDocs = await dataLakeRepository.findByDatalakeTags(dataLakeTags);
  const lakeDocsByTag = new Map(lakeDocs.map(doc => [doc.datalakeTag, doc]));
  return lakes.map(lake => {
    const doc = lakeDocsByTag.get(lake.datalakeTag);
    if (doc) {
      // `?? lake.fileTagPrefix`: a doc whose own prefix is unset must not silently lose the
      // prefix arm it had before this scope existed.
      return {
        kind: 'owned',
        datalakeTag: lake.datalakeTag,
        fileTagPrefix: doc.fileTagPrefix ?? lake.fileTagPrefix,
        creatorUserId: doc.createdByUserId,
      };
    }
    // POSITIVE evidence of registry-ness, never the absence of a document - see
    // queryDataLakeTagCounts' identical branch for why (a misclassification here would turn a
    // dynamic lake's user-chosen prefix into a cross-tenant read arm).
    if (STATIC_LAKE_IDS.has(lake.id)) {
      return dataLakeService.registryMembershipScope(lake);
    }
    return { kind: 'owned', datalakeTag: lake.datalakeTag };
  });
}

/**
 * Browse articles across the given lakes (resolved by `resolveAccessibleLakes`).
 * Serves `/api/data-lakes/articles` - same content
 * query, different access gate enforced by the caller.
 */
export async function queryDataLakeArticles(
  req: EntitlementRequest,
  lakes: DataLakeConfig[],
  query: DataLakeArticlesQuery
): Promise<{ data: unknown[]; total: number; hasMore: boolean; grantedLakeIds?: string[] }> {
  if (lakes.length === 0) return { data: [], total: 0, hasMore: false };

  const dataLakeTags = lakes.map(dl => dl.datalakeTag);
  const { openTagPrefixes } = splitTagPrefixes(lakes);

  // Single-article fetch (deep link) - authorize it against the accessible lakes.
  // Access = the file carries an accessible lake's unique meta-tag (covers dynamic
  // lakes safely - membership IS the meta-tag) OR a static-registry (open) prefix.
  // A dynamic lake's user-controlled prefix is deliberately NOT a grant here - that
  // was the cross-tenant hole; dynamic-lake files are reached via the meta-tag.
  // Narrowed like `search`/`tags` below: an array reaching findById casts to a Mongoose CastError
  // and 500s the deep-link read. /api/data-lakes/articles has no `[id]` route segment, so nothing
  // else overwrites this with a single value.
  const articleId = firstQueryValue(query.id);
  if (articleId) {
    const file = await fabFileRepository.findById(articleId);
    const grantedLakeIds = file && !file.deletedAt ? grantingLakes(lakes, file.tags?.map(t => t.name) ?? []) : [];
    if (!file || grantedLakeIds.length === 0) {
      return { data: [], total: 0, hasMore: false };
    }
    const { content, chunks, vector, ...metadata } = file as unknown as Record<string, unknown>;
    // A held/blocked uploaded image must not hand out its cached URL via the
    // deep-link/single-id branch. Keep the metadata (so the client can render a
    // placeholder) but strip the servable URL fields, mirroring fabFileService/get.ts.
    if (!isImageServeable(file)) {
      delete metadata.fileUrl;
      delete metadata.fileUrlExpireAt;
    }
    // Surfaced so the caller's own access-audit attribution can reuse this SAME grantingLakes
    // result (this is the sound, single-authorized-file case) instead of recomputing it - see
    // apps/client/pages/api/data-lakes/articles.ts.
    return { data: [metadata], total: 1, hasMore: false, grantedLakeIds: grantedLakeIds.map(l => l.id) };
  }

  const rawTags = query.tags;
  const tags: string[] = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];
  const search = firstQueryValue(query.search) ?? '';
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(2000, Math.max(1, Number(query.limit) || 50));
  const sortBy = query.sortBy === 'createdAt' ? ('createdAt' as const) : ('fileName' as const);
  const sortDir = query.sortDir === 'desc' ? ('desc' as const) : ('asc' as const);

  const user = req.user!;
  // Dynamic-lake arms, each anchored to that lake's creator (#2243) - never the registry kind,
  // whose prefix arm is unanchored and unsafe across a multi-lake query like this one. Registry
  // lakes keep matching through the OPEN `dataLakeTagPrefixes` arm above instead.
  const membershipScopes = await buildLakeMembershipScopes(lakes, dataLakeTags);
  const lakeMemberships = membershipScopes.filter(scope => scope.kind !== 'registry');
  const result = await fabFilesService.search(
    user.id,
    {
      search,
      filters: { tags, shared: false },
      pagination: { page, limit },
      order: { by: sortBy, direction: sortDir },
      options: {
        textSearch: !!search,
        excludeContent: true,
      },
    },
    {
      db: {
        fabFiles: fabFileRepository,
        users: userRepository,
        adminSettings: adminSettingsRepository,
        projects: projectRepository,
      },
      storage: {
        generateSignedUrl: async (path: string, expireInSeconds: number) => {
          try {
            return await getFilesStorage().getSignedUrl(path, 'get', { expiresIn: expireInSeconds });
          } catch {
            return null;
          }
        },
      },
    },
    // Resolved from the lakes this caller can actually reach, never from the query string
    // (see SearchFabFilesServerOptions).
    {
      includeShared: true,
      userGroups: user.groups ?? [],
      dataLakeTags,
      dataLakeTagPrefixes: openTagPrefixes,
      lakeMemberships,
    }
  );

  return { data: result.data, total: result.total, hasMore: result.hasMore };
}

/**
 * Tag-occurrence + unique-file counts that drive the Explorer's tag tree and the
 * KB-article stats. Serves `/api/data-lakes/tag-counts`.
 */
export async function queryDataLakeTagCounts(
  req: EntitlementRequest,
  lakes: DataLakeConfig[]
): Promise<{
  tagCounts: Awaited<ReturnType<typeof fabFileRepository.countDataLakeTagsByPrefix>>;
  uniqueArticleCounts: Awaited<ReturnType<typeof fabFileRepository.countDataLakeUniqueFilesByPrefix>>;
  lakeFileCounts: Record<string, number>;
}> {
  if (lakes.length === 0) {
    return { tagCounts: [], uniqueArticleCounts: { total: 0, byPrefix: {} }, lakeFileCounts: {} };
  }
  const dataLakeTags = lakes.map(dl => dl.datalakeTag);
  const { openTagPrefixes, scopedTagPrefixes } = splitTagPrefixes(lakes);
  // The positional prefix list drives the tree's regex grouping (both static + dynamic
  // content tags appear as branches). The ownership gate that keeps a colliding prefix from
  // surfacing another tenant's tags is `$or: buildOwnershipConditions(...)` inside the counter -
  // base access (owned/shared/group), not a prefix arm of these options.
  const allPrefixes = [...openTagPrefixes, ...scopedTagPrefixes];
  const user = req.user!;
  const countOptions = {
    userGroups: user.groups ?? [],
    dataLakeTags,
    dataLakeTagPrefixes: openTagPrefixes,
  };

  // Per-lake sizes come from the membership predicate, not from `<prefix>:` tag matches: a lake
  // whose files carry only the meta-tag (what the upload wizard produces) counts 0 under the
  // prefix rule, and a file carrying several taxonomy tags counts several times. It previously
  // fell through to meta-tag-only for a registry lake, which UNDER-COUNTED it against its own
  // browse - the browse has always matched the open prefix arm. That is the drift the
  // discriminated scope exists to stop; these counts and GET /api/data-lakes/:id/articles now
  // resolve the same membership for both lake kinds.
  const membershipScopes = await buildLakeMembershipScopes(lakes, dataLakeTags);

  const [tagCounts, uniqueArticleCounts, lakeFileCounts] = await Promise.all([
    fabFileRepository.countDataLakeTagsByPrefix(user.id, allPrefixes, countOptions),
    fabFileRepository.countDataLakeUniqueFilesByPrefix(user.id, allPrefixes, countOptions),
    fabFileRepository.countDataLakeFilesByMembership(membershipScopes),
  ]);

  return { tagCounts, uniqueArticleCounts, lakeFileCounts };
}
