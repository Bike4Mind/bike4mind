import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';
import { fabFilesService } from '@bike4mind/services';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

interface ArticlesQuery {
  id: string;
  tags?: string | string[];
  search?: string;
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
      db: { dataLakes: dataLakeRepository },
    });

    const datalakeTag = dataLake.datalakeTag;
    if (!datalakeTag) {
      return res.json({ data: [], total: 0, hasMore: false });
    }

    const rawTags = req.query.tags;
    const filterTags: string[] = rawTags ? (Array.isArray(rawTags) ? rawTags : [rawTags]) : [];
    const search = req.query.search ?? '';
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const sortBy = req.query.sortBy === 'createdAt' ? ('createdAt' as const) : ('fileName' as const);
    const sortDir = req.query.sortDir === 'desc' ? ('desc' as const) : ('asc' as const);

    // User-provided tags are an additional AND filter. Lake scoping is handled by the
    // ownership conditions (dataLakeTags + scopedTagPrefixes) - NOT mixed into the tag
    // filter with OR semantics - and `restrictToDataLake` drops the broad owner/shared
    // arms so this view returns ONLY this lake's files, not every file the user owns
    // (other lakes' files were bleeding into every lake's "Uncategorized").
    const result = await fabFilesService.search(
      userId,
      {
        search,
        filters: { tags: filterTags, shared: false },
        pagination: { page, limit },
        order: { by: sortBy, direction: sortDir },
        options: {
          textSearch: !!search,
          includeShared: true,
          userGroups: req.user.groups ?? [],
          dataLakeTags: [datalakeTag],
          // This is a single DYNAMIC lake, so its user-controlled prefix is SCOPED -
          // matched only within owner/org access so a colliding prefix can't leak
          // another tenant's files. The unique datalakeTag above safely covers
          // membership; the scoped prefix additionally catches prefixed content tags.
          scopedTagPrefixes: [dataLake.fileTagPrefix],
          // Single-lake browser: only this lake's files.
          restrictToDataLake: true,
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
      }
    );

    return res.json({ data: result.data, total: result.total, hasMore: result.hasMore });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
