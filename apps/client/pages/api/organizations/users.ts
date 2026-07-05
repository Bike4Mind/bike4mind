import { TableQuery } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { convertIds, Organization, User, UserActivityCounter, convertPipelineForDocumentDB } from '@bike4mind/database';
import { NotFoundError } from '@server/utils/errors';
import { mongoose } from '@bike4mind/database';
import qs from 'qs';
import { Pagination } from '@bike4mind/utils';

const handler = baseApi().get(
  asyncHandler<unknown, unknown, unknown, Record<string, string>>(async (req, res) => {
    const { pageSize, pageNumber, sort, filters } = TableQuery.parse({
      ...qs.parse(req.query),
      pageSize: Number(req.query.pageSize),
      pageNumber: Number(req.query.pageNumber),
    });

    try {
      let orgId = req.user.organizationId!;
      if (req.user.isAdmin && filters?.orgId) {
        if (mongoose.Types.ObjectId.isValid(filters?.orgId)) {
          orgId = filters?.orgId;
        }
      }

      const organization = await Organization.findById(orgId).select('users -_id');
      if (!organization) throw new NotFoundError('Organization not found');

      const userIds = organization?.users.map(user => user.userId) ?? [];

      const userQuery = [{ $match: { _id: { $in: convertIds(userIds) } } }];
      const pagination = new Pagination(pageSize, pageNumber);
      const pipeline: mongoose.PipelineStage[] = [...userQuery, { $skip: pagination.skip() }, { $limit: pageSize }];

      pipeline.push(
        {
          $lookup: {
            from: UserActivityCounter.collection.name,
            // _id is an ObjectId but userId on the counter is a string; cast for the match.
            let: { userId: { $toString: '$_id' } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$userId', '$$userId'] },
                },
              },
            ],
            as: 'activityCounters',
          },
        },
        { $unwind: { path: '$activityCounters', preserveNullAndEmptyArrays: true } },

        // Flag tags matching 'export'/'download' via regex.
        {
          $addFields: {
            containsExport: {
              $cond: {
                if: { $isArray: '$activityCounters.tags' },
                then: {
                  $anyElementTrue: {
                    $map: {
                      input: '$activityCounters.tags',
                      as: 'tag',
                      in: { $regexMatch: { input: '$$tag', regex: /export/i } },
                    },
                  },
                },
                else: false,
              },
            },
            containsDownload: {
              $cond: {
                if: { $isArray: '$activityCounters.tags' },
                then: {
                  $anyElementTrue: {
                    $map: {
                      input: '$activityCounters.tags',
                      as: 'tag',
                      in: { $regexMatch: { input: '$$tag', regex: /download/i } },
                    },
                  },
                },
                else: false,
              },
            },
          },
        },

        {
          $group: {
            _id: '$_id',
            name: { $first: '$name' },
            email: { $first: '$email' },
            numLogins: {
              $sum: {
                $cond: [{ $eq: ['$activityCounters.action', 'numLogins'] }, '$activityCounters.count', 0],
              },
            },
            numExports: {
              $sum: {
                $cond: ['$containsExport', '$activityCounters.count', 0],
              },
            },
            lastExport: {
              $max: {
                $cond: ['$containsExport', '$activityCounters.updatedAt', null],
              },
            },
            numDownloads: {
              $sum: {
                $cond: ['$containsDownload', '$activityCounters.count', 0],
              },
            },
            lastDownload: {
              $max: {
                $cond: ['$containsDownload', '$activityCounters.updatedAt', null],
              },
            },
            loginRecords: { $push: '$loginRecords' },
          },
        },

        { $unwind: { path: '$loginRecords', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$loginRecords', preserveNullAndEmptyArrays: true } },

        { $sort: { 'loginRecords.loginTime': -1 } },

        // Regroup to pick the latest login time (post-sort, $first is the max).
        {
          $group: {
            _id: '$name',
            name: { $first: '$name' },
            email: { $first: '$email' },
            numLogins: { $first: '$numLogins' },
            lastLogin: { $first: '$loginRecords.loginTime' },
            numExports: { $first: '$numExports' },
            lastExport: { $first: '$lastExport' },
            numDownloads: { $first: '$numDownloads' },
            lastDownload: { $first: '$lastDownload' },
          },
        },

        {
          $addFields: {
            lastLogin: {
              $cond: {
                if: { $gt: ['$lastExport', '$lastLogin'] },
                then: '$lastExport',
                else: '$lastLogin',
              },
            },
          },
        },

        {
          $project: {
            _id: 1,
            name: 1,
            email: 1,
            numLogins: 1,
            lastLogin: 1,
            numExports: 1,
            lastExport: 1,
            numDownloads: 1,
            lastDownload: 1,
          },
        }
      );

      if (sort) {
        const sortSplit = sort.split(',');
        pipeline.push({
          $sort: {
            [sortSplit[0]]: sortSplit[1] === 'desc' ? -1 : 1,
          },
        });
      } else {
        pipeline.push({
          $sort: {
            lastLogin: -1,
          },
        });
      }

      const data = await User.aggregate(convertPipelineForDocumentDB(pipeline)).exec();

      const aggregatesDataPipeline = [
        ...userQuery,

        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            users: { $push: '$$ROOT' },
          },
        },

        { $unwind: '$users' },

        {
          $lookup: {
            from: UserActivityCounter.collection.name,
            // _id is an ObjectId but userId on the counter is a string; cast for the match.
            let: { userId: { $toString: '$users._id' } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$userId', '$$userId'] },
                },
              },
            ],
            as: 'activityCounters',
          },
        },

        { $unwind: { path: '$activityCounters', preserveNullAndEmptyArrays: true } },

        // Flag tags matching 'export'/'download' via regex.
        {
          $addFields: {
            containsExport: {
              $cond: {
                if: { $isArray: '$activityCounters.tags' },
                then: {
                  $anyElementTrue: {
                    $map: {
                      input: '$activityCounters.tags',
                      as: 'tag',
                      in: { $regexMatch: { input: '$$tag', regex: /export/i } },
                    },
                  },
                },
                else: false,
              },
            },
            containsDownload: {
              $cond: {
                if: { $isArray: '$activityCounters.tags' },
                then: {
                  $anyElementTrue: {
                    $map: {
                      input: '$activityCounters.tags',
                      as: 'tag',
                      in: { $regexMatch: { input: '$$tag', regex: /download/i } },
                    },
                  },
                },
                else: false,
              },
            },
          },
        },

        {
          $group: {
            _id: null,
            total: { $first: '$total' },
            totalLogins: {
              $sum: {
                $cond: [{ $eq: ['$activityCounters.action', 'numLogins'] }, '$activityCounters.count', 0],
              },
            },
            totalExports: {
              $sum: {
                $cond: ['$containsExport', '$activityCounters.count', 0],
              },
            },
            totalDownloads: {
              $sum: {
                $cond: ['$containsDownload', '$activityCounters.count', 0],
              },
            },
          },
        },

        { $project: { _id: 0, total: 1, totalLogins: 1, totalExports: 1, totalDownloads: 1 } },
      ];

      const aggregatesData = await User.aggregate(convertPipelineForDocumentDB(aggregatesDataPipeline)).exec();

      const aggregates = { total: 0, totalLogins: 0, totalExports: 0, totalDownloads: 0 };
      if (aggregatesData.length) {
        const aggregatesDataItem = aggregatesData[0];
        aggregates.total = aggregatesDataItem.total;
        aggregates.totalLogins = aggregatesDataItem.totalLogins;
        aggregates.totalExports = aggregatesDataItem.totalExports;
        aggregates.totalDownloads = aggregatesDataItem.totalDownloads;
      }

      const subscriptionsPipeline = [
        { $match: { _id: new mongoose.Types.ObjectId(orgId) } },
        { $unwind: '$subscriptions' },
        {
          $project: {
            _id: 0,
            startDate: '$subscriptions.startDate',
            endDate: '$subscriptions.endDate',
            service: '$subscriptions.service',
          },
        },
      ];

      const subscriptions = await Organization.aggregate(convertPipelineForDocumentDB(subscriptionsPipeline)).exec();

      const meta = { pagination: pagination.get(aggregates.total), aggregates, subscriptions };

      return res.status(200).json({ data, meta });
    } catch (error) {
      return res.status(500).json({ message: 'Internal Server Error', error });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
