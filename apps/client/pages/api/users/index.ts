import { accessibleBy } from '@casl/mongoose';
import { baseApi } from '@server/middlewares/baseApi';
import {
  IUserObject,
  Project,
  User,
  executeFacetCompatible,
  convertPipelineForDocumentDB,
  projectRepository,
} from '@bike4mind/database';
import { mongoose } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import {
  ADMIN_DEFAULT_SORT_FIELD,
  ADMIN_USER_PROJECTION,
  ADMIN_USER_SORT_FIELDS,
  PUBLIC_DEFAULT_SORT_FIELD,
  PUBLIC_USER_LIST_PROJECTION,
  PUBLIC_USER_SORT_FIELDS,
} from '@client/app/utils/adminUserProjection';
import * as z from 'zod';
import qs from 'qs';
import { Request } from 'express';

const querySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default(1),
  limit: z.string().regex(/^\d+$/).transform(Number).default(10),
  search: z
    .string()
    .optional()
    .transform(val => val?.trim()),
  sortField: z.string().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  orgSearch: z.array(z.string()).default(['all']),
  tags: z.array(z.string()).optional(),
  projectId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
  publicView: z
    .string()
    .optional()
    .transform(val => val === 'true'),
  downloadAll: z
    .string()
    .optional()
    .transform(val => val === 'true'),
});

const handler = baseApi().get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
  try {
    const { page, limit, search, publicView, sortField, sortOrder, orgSearch, tags, downloadAll, projectId } =
      querySchema.parse(qs.parse(req.query));

    // publicView is the limited directory search used by invite/member pickers; it
    // bypasses CASL by design (regular users have no read grant on User). Keep it
    // usable for targeted lookup, but not as a bulk-export or full-directory dump:
    // non-admins require a minimum search term to prevent blind pagination over all
    // users, downloadAll is admin-only, and the page size is hard-capped.
    const isAdmin = !!req.user?.isAdmin;
    if (publicView && !isAdmin) {
      // projectId-scoped requests show members of one specific project rather than the whole
      // directory, so they are exempt from the search-term minimum. What makes that safe is
      // the access check on the project itself, further down -- not the narrowing alone.
      if (!projectId && (!search || search.length < 3)) {
        return res.status(400).json({ message: 'A search term of at least 3 characters is required.' });
      }
      if (downloadAll) {
        return res.status(403).json({ message: 'Bulk user export is admin-only.' });
      }
    } else if (downloadAll && !isAdmin) {
      return res.status(403).json({ message: 'Bulk user export is admin-only.' });
    }
    const PUBLIC_VIEW_MAX_LIMIT = 50;
    const effectiveLimit = publicView && !isAdmin ? Math.min(limit, PUBLIC_VIEW_MAX_LIMIT) : limit;

    // $sort runs before $project, so the allowlist is keyed off the same publicView flag that
    // picks the projection: a caller can only rank on fields their own response returns.
    // Out-of-allowlist values fall back to the default rather than 400, so a stale bookmark
    // still renders a list instead of an error.
    const allowedSortFields = publicView ? PUBLIC_USER_SORT_FIELDS : ADMIN_USER_SORT_FIELDS;
    const defaultSortField = publicView ? PUBLIC_DEFAULT_SORT_FIELD : ADMIN_DEFAULT_SORT_FIELD;
    const effectiveSortField = allowedSortFields.has(sortField) ? sortField : defaultSortField;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: mongoose.FilterQuery<any> = publicView
      ? User.find().getQuery()
      : accessibleBy(req.ability!, 'read').ofType(User);

    const conditions = [];
    if (search) {
      const escapedSearch = escapeRegex(search);
      // An unanchored substring over email made publicView a directory crawl: `search=com`
      // matched every address on the instance. Anchor the public picker's match instead --
      // username/email at the start, name at the start of any word so a last-name lookup
      // still works. Admins and the CASL-scoped path keep substring search.
      const searchConditions: mongoose.FilterQuery<typeof User>[] =
        publicView && !isAdmin
          ? [
              { name: { $regex: `(?:^|[\\s.\\-])${escapedSearch}`, $options: 'i' } },
              { username: { $regex: `^${escapedSearch}`, $options: 'i' } },
              { email: { $regex: `^${escapedSearch}`, $options: 'i' } },
            ]
          : [
              { name: { $regex: escapedSearch, $options: 'i' } },
              { username: { $regex: escapedSearch, $options: 'i' } },
              { email: { $regex: escapedSearch, $options: 'i' } },
            ];

      // If the search string looks like a valid ObjectId, add exact match condition
      if (/^[0-9a-fA-F]{24}$/.test(search)) {
        searchConditions.push({ _id: new mongoose.Types.ObjectId(search) });
      }

      conditions.push({
        $or: searchConditions,
      });
    }

    // tags selects on isAdmin/tags, neither of which the public projection returns. On the
    // CASL-scoped path that reveals nothing the caller could not already read, but publicView
    // bypasses CASL, so for a non-admin there `tags[]=Admin` answers "who are the admins".
    const canFilterByTags = isAdmin || !publicView;
    if (canFilterByTags && tags && tags.length > 0) {
      const hasAdminTag = tags.includes('Admin');
      const otherTags = tags.filter(tag => tag !== 'Admin');

      if (hasAdminTag && otherTags.length > 0) {
        conditions.push({
          $or: [{ isAdmin: true }, { tags: { $in: otherTags } }],
        });
      } else if (hasAdminTag) {
        conditions.push({ isAdmin: true });
      } else if (otherTags.length > 0) {
        conditions.push({ tags: { $in: otherTags } });
      }
    }

    // Combine conditions with the base query
    if (conditions.length > 0) {
      query = {
        $and: [
          ...(query ? [query] : []),
          {
            $and: conditions,
          },
        ],
      };
    }

    // Move organization filtering to the aggregation pipeline
    let organizationFilter = {};
    if (!orgSearch.includes('all')) {
      const conditions: Record<string, unknown>[] = [];

      // Filter by specific org names (excluding 'Unassigned')
      const orgNames = orgSearch.filter((name: string) => name !== 'Unassigned');
      if (orgNames.length > 0) {
        conditions.push({ 'organization.name': { $in: orgNames } });
      }

      if (orgSearch.includes('Unassigned')) {
        conditions.push({ organization: { $exists: false } });
        conditions.push({ organization: null });
      }

      if (conditions.length > 0) {
        organizationFilter = { $or: conditions };
      }
    }

    if (projectId) {
      // This branch is exempt from the search-term minimum and publicView bypasses CASL, so
      // without an access check it hands any caller an arbitrary project's roster. Admins keep
      // the unrestricted lookup; everyone else must hold read/write on the project. A caller
      // without access gets the same 404 as a project that does not exist, so this does not
      // become a project-existence oracle.
      const project = isAdmin
        ? await Project.findById(projectId)
        : await projectRepository.shareable.findAccessibleById(req.user, projectId);

      if (!project) {
        return res.status(404).json({ message: 'Project not found.' });
      }

      query = {
        ...query,
        _id: { $in: project.users.map(u => new mongoose.Types.ObjectId(u.userId)) },
      };
    }

    let baseAggregationPipeline = [];

    // If using text search, it must be in the first $match stage
    const hasTextSearch = search && conditions.some(c => c && typeof c === 'object' && '$text' in c);
    if (hasTextSearch) {
      baseAggregationPipeline = [
        {
          $match: { $text: { $search: search } },
        },
        {
          $addFields: {
            score: { $meta: 'textScore' },
          },
        },
        // Secondary $match for other filters
        {
          $match: {
            ...(Object.keys(query).length > 0 ? query : {}),
          },
        },
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            as: 'organization',
          },
        },
        {
          $unwind: {
            path: '$organization',
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: organizationFilter,
        },
        {
          $sort: {
            score: -1,
            [effectiveSortField]: sortOrder === 'asc' ? 1 : -1,
          },
        },
        {
          $project: {
            ...(publicView ? PUBLIC_USER_LIST_PROJECTION : ADMIN_USER_PROJECTION),
            score: 1,
          },
        },
      ];
    } else {
      // Standard pipeline without text search
      baseAggregationPipeline = [
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            as: 'organization',
          },
        },
        {
          $unwind: {
            path: '$organization',
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: {
            $and: [query, organizationFilter],
          },
        },
        { $sort: { [effectiveSortField]: sortOrder === 'asc' ? 1 : -1 } },
        { $project: publicView ? PUBLIC_USER_LIST_PROJECTION : ADMIN_USER_PROJECTION },
      ];
    }

    let results;

    if (!downloadAll) {
      const convertedBasePipeline = convertPipelineForDocumentDB(baseAggregationPipeline);

      results = await executeFacetCompatible(User, convertedBasePipeline, {
        totalCount: [{ $count: 'count' }],
        paginatedResults: [{ $skip: (page - 1) * effectiveLimit }, { $limit: effectiveLimit }],
      });

      const total = results[0].totalCount[0]?.count || 0;
      const users = results[0].paginatedResults;

      await User.populate(users, { path: 'organizationId' });

      return res.json({
        users: users.map((user: IUserObject) => User.hydrate(user)),
        currentPage: page,
        totalPages: Math.ceil(total / effectiveLimit),
        totalUsers: total,
      });
    } else {
      const convertedBasePipeline = convertPipelineForDocumentDB(baseAggregationPipeline);
      results = await User.aggregate(convertedBasePipeline);

      await User.populate(results, { path: 'organizationId' });

      return res.json({
        users: results.map((user: IUserObject) => User.hydrate(user)),
        totalUsers: results.length,
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid query parameters', error: error.issues });
    } else {
      console.error('Error:', error);
      return res.status(500).json({ message: 'Internal Server Error' });
    }
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
