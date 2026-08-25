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
import { DATA_LAKES, getAccessibleDataLakes, hasDeveloperUserTag, isImageServeable } from '@bike4mind/common';
import type { DataLakeConfig } from '@bike4mind/common';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
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
  // Grants: without them `listDataLakes` degrades both grant reads to empty, so a lake reached by an
  // owner or curator grant is absent from every browse surface - including the file-access check in
  // `pages/api/files/[id]` - even though the read gate admits it. Settings rides along, unlike the
  // Slack `list` reply which deliberately omits it: this is a READ surface, so it must track the
  // `EnforceLakeReadGrants` cutover rather than freeze at owner/curator, or a reader-granted lake
  // would pass the gate post-cutover and still be invisible here.
  const lakeDb = {
    dataLakes: dataLakeRepository,
    dataLakeAccessGrants: dataLakeAccessGrantRepository,
    settings: adminSettingsRepository,
  };
  const dynamic = ctx.isAdmin
    ? await dataLakeService.listAllDataLakes(ctx, { db: lakeDb })
    : await dataLakeService.listDataLakes(ctx, { db: lakeDb });

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
  id?: string;
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
 *  - SCOPED - dynamic (user-created) lakes: prefix is user-controlled, so it must be
 *    matched only within owner/org access (see buildOwnershipConditions). Mixing them
 *    is the cross-tenant leak this guards against.
 * The unique `datalakeTag` (exact match, never a prefix) safely covers every lake.
 *
 * Normalized through `normalizeTagPrefix` - the same predicate `buildOwnershipConditions`
 * applies - because the tag-count aggregates build their regex straight from what we return
 * here. Handing them the raw field let the two disagree: a lake stored with a padded prefix
 * (` a:` passes create validation, which never trims) matched `^(a:)` in the ownership arm
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
  const { openTagPrefixes, scopedTagPrefixes } = splitTagPrefixes(lakes);

  // Single-article fetch (deep link) - authorize it against the accessible lakes.
  // Access = the file carries an accessible lake's unique meta-tag (covers dynamic
  // lakes safely - membership IS the meta-tag) OR a static-registry (open) prefix.
  // A dynamic lake's user-controlled prefix is deliberately NOT a grant here - that
  // was the cross-tenant hole; dynamic-lake files are reached via the meta-tag.
  if (query.id) {
    const file = await fabFileRepository.findById(query.id);
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
      scopedTagPrefixes,
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
  // content tags appear as branches); the ownership filter inside the counter - built
  // from these split options - is what scopes dynamic-prefix files to the owner/org, so
  // a colliding prefix can't surface another tenant's tags in the tree.
  const allPrefixes = [...openTagPrefixes, ...scopedTagPrefixes];
  const user = req.user!;
  const countOptions = {
    userGroups: user.groups ?? [],
    dataLakeTags,
    dataLakeTagPrefixes: openTagPrefixes,
    scopedTagPrefixes,
  };

  // Per-lake sizes come from the membership predicate, not from `<prefix>:` tag matches: a lake
  // whose files carry only the meta-tag (what the upload wizard produces) counts 0 under the
  // prefix rule, and a file carrying several taxonomy tags counts several times. The lake docs
  // are fetched because the predicate's prefix arm has to be anchored to the lake's CREATOR -
  // the config the browse surfaces receive deliberately carries no owner id. A static registry
  // lake has no doc and no creator, so it falls back to meta-tag-only matching, which is the
  // safe direction (see buildDataLakeMembershipFilter).
  const lakeDocs = await Promise.all(dataLakeTags.map(tag => dataLakeRepository.findByDatalakeTag(tag)));
  const membershipScopes = lakes.map((lake, i) => ({
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lakeDocs[i]?.fileTagPrefix ?? lake.fileTagPrefix,
    creatorUserId: lakeDocs[i]?.createdByUserId,
  }));

  const [tagCounts, uniqueArticleCounts, lakeFileCounts] = await Promise.all([
    fabFileRepository.countDataLakeTagsByPrefix(user.id, allPrefixes, countOptions),
    fabFileRepository.countDataLakeUniqueFilesByPrefix(user.id, allPrefixes, countOptions),
    fabFileRepository.countDataLakeFilesByMembership(membershipScopes),
  ]);

  return { tagCounts, uniqueArticleCounts, lakeFileCounts };
}
