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
  PICKER_USER_PROJECTION,
  PICKER_USER_SORT_FIELDS,
  PUBLIC_DEFAULT_SORT_FIELD,
  PUBLIC_USER_LIST_PROJECTION,
  PUBLIC_USER_SORT_FIELDS,
} from '@client/app/utils/adminUserProjection';
import { findSharedWorkspaceUserIds } from '@server/users/sharedWorkspaceUserIds';
import { findPendingProjectInviteeIds } from '@server/users/pendingProjectInviteeIds';
import * as z from 'zod';
import qs from 'qs';
import { Request } from 'express';

const querySchema = z.object({
  // Positive only: 0 reaches $limit/$skip as an invalid stage and surfaces as a 500.
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .default(1),
  limit: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .default(10),
  search: z
    .string()
    .optional()
    .transform(val => val?.trim()),
  sortField: z.string().default('createdAt'),
  // No default here - the effective order depends on which sort field is actually applied,
  // resolved below once effectiveSortField is known.
  sortOrder: z.enum(['asc', 'desc']).optional(),
  orgSearch: z.array(z.string()).default(['all']),
  tags: z.array(z.string()).optional(),
  projectId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
  // Flags rows with an open invite to this project (`pendingInvite`); does not narrow the results.
  pendingInviteProjectId: z
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
    const {
      page,
      limit,
      search,
      publicView,
      sortField,
      sortOrder,
      orgSearch,
      tags,
      downloadAll,
      projectId,
      pendingInviteProjectId,
    } = querySchema.parse(qs.parse(req.query));

    // publicView is the limited directory search used by invite/member pickers; it
    // bypasses CASL by design (regular users have no read grant on User). Keep it
    // usable for targeted lookup, but not as a bulk-export or full-directory dump:
    // non-admins require a minimum search term to prevent blind pagination over all
    // users, downloadAll is admin-only, and the page size is hard-capped.
    const isAdmin = !!req.user?.isAdmin;
    const isPicker = publicView && !isAdmin;
    if (isPicker) {
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
    const allowedSortFields = isPicker
      ? PICKER_USER_SORT_FIELDS
      : publicView
        ? PUBLIC_USER_SORT_FIELDS
        : ADMIN_USER_SORT_FIELDS;
    const defaultSortField = publicView ? PUBLIC_DEFAULT_SORT_FIELD : ADMIN_DEFAULT_SORT_FIELD;
    const effectiveSortField = allowedSortFields.has(sortField) ? sortField : defaultSortField;
    // username reads better ascending (A-Z); createdAt keeps the historical newest-first
    // default. Only kicks in when the caller did not explicitly ask for an order, so an
    // explicit sortOrder=desc on the public picker still reverses it.
    const effectiveSortOrder = sortOrder ?? (effectiveSortField === PUBLIC_DEFAULT_SORT_FIELD ? 'asc' : 'desc');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: mongoose.FilterQuery<any> = publicView
      ? User.find().getQuery()
      : accessibleBy(req.ability!, 'read').ofType(User);

    // The non-admin picker only reaches people the caller already works with: anyone sharing an
    // organization or project. A projectId request is already narrowed to that project's roster
    // (and access-checked below), which is a subset of the same set.
    const sharedUserIds = isPicker && !projectId ? await findSharedWorkspaceUserIds(req.user) : undefined;

    const conditions = [];
    if (search) {
      const escapedSearch = escapeRegex(search);
      const idConditions: mongoose.FilterQuery<typeof User>[] = /^[0-9a-fA-F]{24}$/.test(search)
        ? [{ _id: new mongoose.Types.ObjectId(search) }]
        : [];

      if (isPicker) {
        // Name (at the start of any word) or username prefix, within the shared-workspace scope.
        // Email is never prefix-matched here: the only email match is an exact, fully typed
        // address, which may reach a user outside that scope - that row is stripped to id + name
        // further down, so the caller learns nothing beyond the address they already had.
        const prefixMatch = {
          $or: [
            { name: { $regex: `(?:^|[\\s.\\-])${escapedSearch}`, $options: 'i' } },
            { username: { $regex: `^${escapedSearch}`, $options: 'i' } },
            ...idConditions,
          ],
        };
        const scopedMatch = sharedUserIds
          ? { $and: [{ _id: { $in: [...sharedUserIds].map(id => new mongoose.Types.ObjectId(id)) } }, prefixMatch] }
          : prefixMatch;
        conditions.push({
          $or: [
            scopedMatch,
            ...(search.includes('@') ? [{ email: { $regex: `^${escapedSearch}$`, $options: 'i' } }] : []),
          ],
        });
      } else {
        conditions.push({
          $or: [
            { name: { $regex: escapedSearch, $options: 'i' } },
            { username: { $regex: escapedSearch, $options: 'i' } },
            { email: { $regex: escapedSearch, $options: 'i' } },
            ...idConditions,
          ],
        });
      }
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
    // Ignored for the picker: filtering on organization.name, which it does not return, would
    // answer "which organization is this exact-email user in".
    if (!isPicker && !orgSearch.includes('all')) {
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

    const projection = isPicker
      ? PICKER_USER_PROJECTION
      : publicView
        ? PUBLIC_USER_LIST_PROJECTION
        : ADMIN_USER_PROJECTION;

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
            [effectiveSortField]: effectiveSortOrder === 'asc' ? 1 : -1,
          },
        },
        {
          $project: {
            ...projection,
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
        { $sort: { [effectiveSortField]: effectiveSortOrder === 'asc' ? 1 : -1 } },
        { $project: projection },
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
      const users: IUserObject[] = results[0].paginatedResults;

      // Project invites store recipients as emails, which the picker never returns, so the
      // "already invited" match is made here instead of in the modal. A caller without share
      // access gets no flag at all (null -> undefined) rather than an error: the flag is an
      // annotation on the search, and must not break the search itself.
      const pendingInviteeIds = pendingInviteProjectId
        ? ((await findPendingProjectInviteeIds(
            req.user,
            pendingInviteProjectId,
            users.map(user => String(user._id))
          )) ?? undefined)
        : undefined;

      const pagination = {
        currentPage: page,
        totalPages: Math.ceil(total / effectiveLimit),
        totalUsers: total,
      };

      if (isPicker) {
        // Built field by field, not hydrated: hydrate fills every unprojected path with its schema
        // default (isAdmin: false, level, ...), which would ship as if it were the user's own data.
        // A row outside the shared-workspace scope can only be the exact-email match, so it gets
        // id and name, nothing else.
        return res.json({
          users: users.map((user: IUserObject) => {
            const id = String(user._id);
            return {
              id,
              name: user.name,
              ...((!sharedUserIds || sharedUserIds.has(id)) && { username: user.username }),
              ...(pendingInviteeIds && { pendingInvite: pendingInviteeIds.has(id) }),
            };
          }),
          ...pagination,
        });
      }

      await User.populate(users, { path: 'organizationId' });

      return res.json({
        users: users.map((user: IUserObject) => {
          const hydrated = User.hydrate(user);
          // pendingInvite is not a User path, so it is added after hydrate rather than through it.
          return pendingInviteeIds
            ? { ...hydrated.toJSON(), pendingInvite: pendingInviteeIds.has(String(user._id)) }
            : hydrated;
        }),
        ...pagination,
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
