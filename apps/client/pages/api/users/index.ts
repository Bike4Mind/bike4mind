import { accessibleBy } from '@casl/mongoose';
import { baseApi } from '@server/middlewares/baseApi';
import { IUserObject, Project, User, executeFacetCompatible, convertPipelineForDocumentDB } from '@bike4mind/database';
import { mongoose } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import * as z from 'zod';
import qs from 'qs';
import { Request } from 'express';

const querySchema = z.object({
  page: z.string().regex(/^\d+$/).transform(Number).default(1),
  limit: z.string().regex(/^\d+$/).transform(Number).default(10),
  search: z.string().optional(),
  sortField: z.string().default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  orgSearch: z.array(z.string()).default(['all']),
  tags: z.array(z.string()).optional(),
  projectId: z.string().optional(),
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: mongoose.FilterQuery<any> = publicView
      ? User.find().getQuery()
      : accessibleBy(req.ability!, 'read').ofType(User);

    const conditions = [];
    if (search) {
      const escapedSearch = escapeRegex(search);
      const searchConditions: mongoose.FilterQuery<typeof User>[] = [
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

    // Add tag filtering conditions
    if (tags && tags.length > 0) {
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
      const project = await Project.findById(projectId);
      query = {
        ...query,
        _id: { $in: project?.users.map(u => new mongoose.Types.ObjectId(u.userId)) },
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
            [sortField]: sortOrder === 'asc' ? 1 : -1,
          },
        },
        {
          $project: {
            ...(publicView ? { _id: 1, username: 1, name: 1, email: 1 } : { password: 0 }),
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
        { $sort: { [sortField]: sortOrder === 'asc' ? 1 : -1 } },
        { $project: publicView ? { _id: 1, username: 1, name: 1, email: 1 } : { password: 0 } },
      ];
    }

    let results;

    if (!downloadAll) {
      const convertedBasePipeline = convertPipelineForDocumentDB(baseAggregationPipeline);

      results = await executeFacetCompatible(User, convertedBasePipeline, {
        totalCount: [{ $count: 'count' }],
        paginatedResults: [{ $skip: (page - 1) * limit }, { $limit: limit }],
      });

      const total = results[0].totalCount[0]?.count || 0;
      const users = results[0].paginatedResults;

      await User.populate(users, { path: 'organizationId' });

      return res.json({
        users: users.map((user: IUserObject) => User.hydrate(user)),
        currentPage: page,
        totalPages: Math.ceil(total / limit),
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
