/**
 * Data Lakes server module - shared lake-scope resolution for the browse surfaces.
 *
 * The consolidated `/api/data-lakes/*` browse endpoints (articles, tag-counts,
 * semantic-search, rlm-answer) all serve content scoped by the lakes a caller
 * can access - files tagged with a lake's `datalakeTag` / `fileTagPrefix`.
 * Access is defined per-lake (`requiredUserTag`/`requiredEntitlement` on the
 * lake config), not per-product. This module owns the one thing every browse
 * surface must share: resolving WHICH lakes a user can see.
 */
import { DATA_LAKES, getAccessibleDataLakes, hasDeveloperUserTag, isImageServeable } from '@bike4mind/common';
import type { DataLakeConfig, AccessContext } from '@bike4mind/common';
import { dataLakeService, fabFilesService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { getRequestEntitlements, type EntitlementRequest } from '@server/entitlements';
import { getFilesStorage } from '@server/utils/storage';

/**
 * Resolve the data lakes a user can browse: their dynamic (DB) lakes - already
 * access-filtered by owner/org/tag inside `listDataLakes` - merged with the static
 * registry lakes they're entitled to. A dynamic lake shadows a same-id static one.
 *
 * Dynamic lakes are deliberately NOT re-filtered through `getAccessibleDataLakes`:
 * the service already authorized them (including owner access), and re-applying the
 * tag/entitlement filter would hide an owner's OWN lake whose `requiredUserTag` they
 * happen not to carry. Static lakes (no owner concept) still go through that filter.
 */
export async function resolveAccessibleLakes(req: EntitlementRequest): Promise<DataLakeConfig[]> {
  const user = req.user!;
  const ctx: AccessContext = {
    userId: user.id,
    isAdmin: !!user.isAdmin,
    userTags: user.tags ?? [],
    organizationId: user.organizationId ?? undefined,
  };

  const dynamic = ctx.isAdmin
    ? await dataLakeService.listAllDataLakes({ db: { dataLakes: dataLakeRepository } })
    : await dataLakeService.listDataLakes(ctx, { db: { dataLakes: dataLakeRepository } });

  // Admin/developer see every static lake; everyone else is scoped by the any-of
  // requiredUserTag/requiredEntitlement filter (resolved entitlement keys included so
  // tag-less domain grants match). Entitlements are resolved lazily - only when
  // we actually need the non-privileged static filter.
  const staticLakes =
    ctx.isAdmin || hasDeveloperUserTag(user.tags)
      ? DATA_LAKES
      : getAccessibleDataLakes(ctx.userTags, undefined, await getRequestEntitlements(req));

  const dynamicIds = new Set(dynamic.map(d => d.id));
  return [...dynamic, ...staticLakes.filter(s => !dynamicIds.has(s.id))];
}

export interface DataLakeArticlesQuery {
  id?: string;
  tags?: string | string[];
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortDir?: string;
}

const STATIC_LAKE_IDS = new Set(DATA_LAKES.map(l => l.id));

/**
 * Split the accessible lakes' file-tag prefixes by provenance:
 *  - OPEN - static-registry lakes (opti:): shared KB, ownership-bypass by design.
 *  - SCOPED - dynamic (user-created) lakes: prefix is user-controlled, so it must be
 *    matched only within owner/org access (see buildOwnershipConditions). Mixing them
 *    is the cross-tenant leak this guards against.
 * The unique `datalakeTag` (exact match, never a prefix) safely covers every lake.
 */
function splitTagPrefixes(lakes: DataLakeConfig[]): { openTagPrefixes: string[]; scopedTagPrefixes: string[] } {
  const openTagPrefixes: string[] = [];
  const scopedTagPrefixes: string[] = [];
  for (const lake of lakes) {
    (STATIC_LAKE_IDS.has(lake.id) ? openTagPrefixes : scopedTagPrefixes).push(lake.fileTagPrefix);
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
): Promise<{ data: unknown[]; total: number; hasMore: boolean }> {
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
    if (!file || file.deletedAt) return { data: [], total: 0, hasMore: false };
    const fileTagNames = file.tags?.map(t => t.name) ?? [];
    const hasMetaTagAccess = dataLakeTags.some(t => fileTagNames.includes(t));
    const hasOpenPrefixAccess = openTagPrefixes.some(p => fileTagNames.some(t => t.startsWith(p)));
    if (!hasMetaTagAccess && !hasOpenPrefixAccess) return { data: [], total: 0, hasMore: false };
    const { content, chunks, vector, ...metadata } = file as unknown as Record<string, unknown>;
    // A held/blocked uploaded image must not hand out its cached URL via the
    // deep-link/single-id branch. Keep the metadata (so the client can render a
    // placeholder) but strip the servable URL fields, mirroring fabFileService/get.ts.
    if (!isImageServeable(file)) {
      delete metadata.fileUrl;
      delete metadata.fileUrlExpireAt;
    }
    return { data: [metadata], total: 1, hasMore: false };
  }

  const rawTags = query.tags;
  const tags: string[] = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];
  const search = query.search ?? '';
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
        includeShared: true,
        userGroups: user.groups ?? [],
        dataLakeTags,
        dataLakeTagPrefixes: openTagPrefixes,
        scopedTagPrefixes,
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
}> {
  if (lakes.length === 0) {
    return { tagCounts: [], uniqueArticleCounts: { total: 0, byPrefix: {} } };
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

  const [tagCounts, uniqueArticleCounts] = await Promise.all([
    fabFileRepository.countDataLakeTagsByPrefix(user.id, allPrefixes, countOptions),
    fabFileRepository.countDataLakeUniqueFilesByPrefix(user.id, allPrefixes, countOptions),
  ]);

  return { tagCounts, uniqueArticleCounts };
}
