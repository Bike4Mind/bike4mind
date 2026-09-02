import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  projectRepository,
  userRepository,
  lakeAccessEventRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { fabFilesService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { resolveAuditPrincipal } from '@server/dataLakes/resolveAuditPrincipal';
import { firstQueryValue } from '@server/dataLakes/firstQueryValue';

interface ArticlesQuery {
  id: string;
  tags?: string | string[];
  search?: string | string[];
  page?: string;
  limit?: string;
  sortBy?: string;
  sortDir?: string;
}

/**
 * GET /api/data-lakes/:id/articles
 *
 * Returns all files belonging to a specific data lake.
 * Verifies access via the shared gate (owner/org/required-tag-or-entitlement).
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request<{}, unknown, unknown, ArticlesQuery>, res) => {
    const userId = req.user.id;
    const { id } = req.query;

    // Single shared gate (org-aware; not-found-style denial).
    const dataLake = await dataLakeService.assertLakeAccess(id, await toAccessContext(req), {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const datalakeTag = dataLake.datalakeTag;
    if (!datalakeTag) {
      return res.json({ data: [], total: 0, hasMore: false });
    }

    const rawTags = req.query.tags;
    const filterTags: string[] = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];
    const search = firstQueryValue(req.query.search) ?? '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const sortBy = req.query.sortBy === 'createdAt' ? ('createdAt' as const) : ('fileName' as const);
    const sortDir = req.query.sortDir === 'desc' ? ('desc' as const) : ('asc' as const);

    // ONE predicate for both lake kinds. For a DB lake that is meta-tag OR a prefix match on a file
    // the CREATOR owns, so this browse lists exactly what archiving or permanently deleting the
    // lake would act on. For a built-in registry lake it is meta-tag OR the registry's own prefix
    // with no ownership arm - a shared knowledge base with many contributors and no creator to
    // anchor to, safe because that prefix is compile-time config rather than user input.
    //
    // This was a hand-rolled `dataLakeTags`/`dataLakeTagPrefixes` pair on the registry arm,
    // justified as "nothing else needs to agree with this arm". Things did need to agree: the count
    // surface (`count_knowledge_base`) carried a copy of that same pair and reports its number as
    // the total this page shows. Both now go through the same scope, pinned by
    // `registryScopeParity.test.ts` - keep it that way.
    const lakeMembership = dataLakeService.isFallbackLake(dataLake)
      ? dataLakeService.registryMembershipScope(dataLake)
      : dataLakeService.lakeMembershipScope(dataLake);

    // User-provided tags are an additional AND filter, never mixed into lake scoping with OR
    // semantics, and `restrictToDataLake` drops the broad owner/shared arms so this view returns
    // ONLY this lake's files rather than every file the viewer owns (other lakes' files were
    // bleeding into every lake's "Uncategorized").
    const result = await fabFilesService.search(
      userId,
      {
        search,
        filters: { tags: filterTags, shared: false },
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
          projects: projectRepository,
          adminSettings: adminSettingsRepository,
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
      {
        // Both arms of the selection above return a scope, so this is never empty - which is
        // what keeps buildOwnershipConditions' restrictToDataLake-with-no-lake-arm throw unreachable.
        lakeMemberships: [lakeMembership],
        includeShared: true,
        userGroups: req.user.groups ?? [],
        // Single-lake browser: only this lake's files.
        restrictToDataLake: true,
      }
    );

    // Best-effort audit write, only when something was actually returned - an empty
    // page reflects no lake content read. The lake is already resolved, so no attribution needed.
    // Awaited (never rethrows): a per-request serverless route must not race a post-response
    // freeze of the execution environment.
    if (result.data.length > 0) {
      await dataLakeService.recordLakeAccessEvent(
        lakeAccessEventRepository,
        {
          ...resolveAuditPrincipal(req.user, req.apiKeyInfo),
          organizationId: normalizeId(req.user.organizationId),
          resolvedLakeIds: [dataLake.id],
          fileIds: (result.data as Array<{ id: string }>).map(f => f.id),
          surface: 'data-lake-articles',
          ...(search ? { queryText: search } : {}),
        },
        req.logger,
        adminSettingsRepository
      );
    }

    return res.json({ data: result.data, total: result.total, hasMore: result.hasMore });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
