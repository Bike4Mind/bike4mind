import mongoose from 'mongoose';
import {
  AiEvents,
  ICounterLog,
  ICounterLogDocument,
  ICounterLogRepository,
  IUserDocument,
  FacetResults,
  parseInternalStaffDomains,
  internalStaffEmailRegex,
} from '@bike4mind/common';
import { dayjs } from '@bike4mind/common';
import utc from 'dayjs/plugin/utc';

// Ensure UTC plugin is available (it should already be extended in @bike4mind/utils)
dayjs.extend(utc);
import BaseRepository from '@bike4mind/db-core';
import { executeFacetCompatible, convertPipelineForDocumentDB } from '../../../utils/documentdb-compat';

export interface ICounterLogModel extends mongoose.Model<ICounterLogDocument, {}, {}>, ICounterLogRepository {}

class CounterLogRepository extends BaseRepository<ICounterLogDocument> implements ICounterLogRepository {
  constructor(model: ICounterLogModel) {
    super(model);
  }

  async findRecentByUserIdAndHasMetadata(userId: string): Promise<ICounterLogDocument[]> {
    const result = await this.model
      .find({ userId, metadata: { $exists: true } })
      .sort({ createdAt: -1 })
      .limit(10);

    return result;
  }

  async findAllWithUserByDate(date: string): Promise<(ICounterLog & { user: IUserDocument })[]> {
    const pipeline = [
      {
        $match: {
          datetime: {
            $gte: new Date(date),
            $lt: new Date(new Date(date).setDate(new Date(date).getDate() + 1)),
          },
        },
      },
      {
        $addFields: {
          userObjectId: { $toObjectId: '$userId' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userObjectId',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    const result = this.model.aggregate(convertPipelineForDocumentDB(pipeline), {
      allowDiskUse: true, // For large datasets
      hint: { datetime: 1 }, // Use the datetime index for initial filtering
    });

    return result;
  }

  async findAllWithUserByDateRange(
    startDate: string,
    endDate: string
  ): Promise<(ICounterLog & { user: IUserDocument })[]> {
    const start = dayjs(startDate).startOf('day').toDate();
    const end = dayjs(endDate).endOf('day').toDate();

    const pipeline = [
      {
        $match: {
          datetime: {
            $gte: start,
            $lte: end,
          },
        },
      },
      {
        $addFields: {
          userObjectId: { $toObjectId: '$userId' },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userObjectId',
          foreignField: '_id',
          as: 'user',
        },
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true,
        },
      },
    ];

    return this.model.aggregate(convertPipelineForDocumentDB(pipeline), {
      allowDiskUse: true, // For large datasets
      hint: { datetime: 1 }, // Use the datetime index for initial filtering
    });
  }

  async metricsByDate(date: string, startDate?: string): Promise<FacetResults[]> {
    const isWeeklyReport = !!startDate;

    // Always work with dates in UTC
    const now = dayjs().utc();
    // Convert input date to UTC immediately
    const queryDate = dayjs.utc(date);

    // Different handling for current day vs past days
    const isToday = queryDate.startOf('day').isSame(now.startOf('day'));
    let weekEnd, weekStart;

    if (isToday) {
      // For today: use current time
      weekEnd = now;
      weekStart = now.subtract(24, 'hours');
    } else {
      // For past dates: use UTC day boundaries
      weekStart = queryDate.startOf('day');
      weekEnd = queryDate.endOf('day');
    }

    // Convert to Date objects while preserving UTC
    const weekEndDate = weekEnd.toDate();
    const weekStartDate = weekStart.toDate();

    // Calculate other ranges
    const lastWeekEnd = weekEnd.subtract(7, 'days').endOf('day').toDate();
    const lastWeekStart = weekStart.subtract(7, 'days').startOf('day').toDate();

    // Only calculate these for weekly reports
    const monthEnd = isWeeklyReport ? weekEndDate : null;
    const monthStart = isWeeklyReport ? dayjs(monthEnd).utc().subtract(30, 'days').startOf('day').toDate() : null;
    const lastMonthEnd = isWeeklyReport ? monthStart : null;
    const lastMonthStart = isWeeklyReport
      ? dayjs(lastMonthEnd).utc().subtract(30, 'days').startOf('day').toDate()
      : null;

    // Internal-user match from the shared NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS list
    // (all internal domains, not a hardcoded one) so it can't drift from the
    // entitlement layer (#172). Null == none configured -> facet matches nothing.
    const internalStaffRegex = internalStaffEmailRegex(
      parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS)
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const facetStages: any = {
      // For daily reports, last24h is the main metric
      last24h: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        {
          $group: {
            _id: '$counterName',
            count: { $sum: 1 },
          },
        },
      ],
      // This week's data (always 7 days for both daily and weekly reports)
      thisWeek: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        {
          $group: {
            _id: '$counterName',
            count: { $sum: 1 },
          },
        },
      ],
      // Previous period data (last 24 hours or last week)
      lastWeek: [
        {
          $match: {
            datetime: {
              $gte: lastWeekStart,
              $lte: lastWeekEnd,
            },
          },
        },
        {
          $group: {
            _id: '$counterName',
            count: { $sum: 1 },
          },
        },
      ],
      // User metrics are needed for both reports
      allUsers: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        {
          $group: {
            _id: '$userId',
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
          },
        },
      ],
      internalUsers: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        {
          $addFields: {
            userObjectId: { $toObjectId: '$userId' },
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'userObjectId',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $unwind: {
            path: '$user',
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $match: internalStaffRegex
            ? {
                $or: [{ userEmail: { $regex: internalStaffRegex } }, { 'user.email': { $regex: internalStaffRegex } }],
              }
            : // None configured: count no internal users.
              { $expr: false },
        },
        {
          $group: {
            _id: '$userId',
          },
        },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
          },
        },
      ],
      // Model usage tracking - different for daily and weekly reports
      topModels: isWeeklyReport
        ? [
            {
              $match: {
                // Exclude failed completions - they write modelName: body?.model || 'unknown'
                // and would inflate every model's count plus create a spurious 'unknown' bucket.
                counterName: { $ne: AiEvents.COMPLETION_API_FAILED },
                'metadata.modelName': { $exists: true },
                datetime: { $gte: weekStartDate, $lte: weekEndDate },
              },
            },
            {
              $group: {
                _id: '$metadata.modelName',
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 10 },
            {
              $lookup: {
                from: 'counterlogs',
                let: { modelName: '$_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $ne: ['$counterName', AiEvents.COMPLETION_API_FAILED] },
                          { $eq: ['$metadata.modelName', '$$modelName'] },
                          { $gte: ['$datetime', lastWeekStart] },
                          { $lte: ['$datetime', lastWeekEnd] },
                        ],
                      },
                    },
                  },
                  {
                    $group: {
                      _id: '$metadata.modelName',
                      count: { $sum: 1 },
                    },
                  },
                ],
                as: 'lastWeekData',
              },
            },
            {
              $lookup: {
                from: 'counterlogs',
                pipeline: [
                  {
                    $match: {
                      counterName: { $ne: AiEvents.COMPLETION_API_FAILED },
                      'metadata.modelName': { $exists: true },
                      datetime: {
                        $gte: lastWeekStart,
                        $lte: lastWeekEnd,
                      },
                    },
                  },
                  {
                    $group: {
                      _id: '$metadata.modelName',
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { count: -1 } },
                  { $limit: 10 },
                ],
                as: 'lastWeekTopModels',
              },
            },
            {
              $project: {
                modelName: '$_id',
                count: 1,
                rankChange: {
                  $let: {
                    vars: {
                      currentRank: { $add: [{ $indexOfArray: ['$ROOT.topModels._id', '$_id'] }, 1] },
                      lastWeekRank: {
                        $add: [
                          {
                            $indexOfArray: ['$lastWeekTopModels._id', '$_id'],
                          },
                          1,
                        ],
                      },
                    },
                    in: {
                      $switch: {
                        branches: [
                          {
                            case: { $eq: ['$$lastWeekRank', 0] },
                            then: 'new',
                          },
                          {
                            case: { $eq: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'same',
                          },
                          {
                            case: { $gt: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'down',
                          },
                          {
                            case: { $lt: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'up',
                          },
                        ],
                        default: 'same',
                      },
                    },
                  },
                },
                lastWeekRank: {
                  $let: {
                    vars: {
                      rank: {
                        $add: [
                          {
                            $indexOfArray: ['$lastWeekTopModels._id', '$_id'],
                          },
                          1,
                        ],
                      },
                    },
                    in: {
                      $cond: {
                        if: { $eq: ['$$rank', 0] },
                        then: '>#10',
                        else: '$$rank',
                      },
                    },
                  },
                },
              },
            },
            { $limit: 3 },
          ]
        : [
            // Daily report version - simpler, no rank comparisons
            {
              $match: {
                // Exclude failed completions - see weekly facet above for rationale.
                counterName: { $ne: AiEvents.COMPLETION_API_FAILED },
                'metadata.modelName': { $exists: true },
                datetime: {
                  $gte: dayjs(weekEndDate).subtract(24, 'hours').toDate(),
                  $lte: weekEndDate,
                },
              },
            },
            {
              $group: {
                _id: '$metadata.modelName',
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
            { $limit: 5 },
            {
              $project: {
                modelName: '$_id',
                count: 1,
              },
            },
          ],
      // User activity tracking - different for daily and weekly reports
      topUsers: isWeeklyReport
        ? [
            {
              $match: {
                datetime: { $gte: weekStartDate, $lte: weekEndDate },
                userId: { $exists: true },
              },
            },
            {
              $addFields: {
                userObjectId: { $toObjectId: '$userId' },
              },
            },
            {
              $lookup: {
                from: 'users',
                localField: 'userObjectId',
                foreignField: '_id',
                as: 'userDetails',
              },
            },
            {
              $group: {
                _id: '$userId',
                interactions: { $sum: 1 },
                email: {
                  $first: {
                    $cond: [
                      { $gt: [{ $size: '$userDetails' }, 0] },
                      { $arrayElemAt: ['$userDetails.email', 0] },
                      '$userEmail',
                    ],
                  },
                },
              },
            },
            { $sort: { interactions: -1 } },
            { $limit: 20 },
            {
              $lookup: {
                from: 'counterlogs',
                pipeline: [
                  {
                    $match: {
                      datetime: {
                        $gte: lastWeekStart,
                        $lte: lastWeekEnd,
                      },
                      userId: { $exists: true },
                    },
                  },
                  {
                    $group: {
                      _id: '$userId',
                      interactions: { $sum: 1 },
                    },
                  },
                  { $sort: { interactions: -1 } },
                  { $limit: 20 },
                ],
                as: 'lastWeekTopUsers',
              },
            },
            {
              $project: {
                _id: 1,
                email: 1,
                interactions: 1,
                rankChange: {
                  $let: {
                    vars: {
                      currentRank: { $add: [{ $indexOfArray: ['$ROOT.topUsers._id', '$_id'] }, 1] },
                      lastWeekRank: {
                        $add: [
                          {
                            $indexOfArray: ['$lastWeekTopUsers._id', '$_id'],
                          },
                          1,
                        ],
                      },
                    },
                    in: {
                      $switch: {
                        branches: [
                          {
                            case: { $eq: ['$$lastWeekRank', 0] },
                            then: 'new',
                          },
                          {
                            case: { $eq: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'same',
                          },
                          {
                            case: { $gt: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'down',
                          },
                          {
                            case: { $lt: ['$$currentRank', '$$lastWeekRank'] },
                            then: 'up',
                          },
                        ],
                        default: 'same',
                      },
                    },
                  },
                },
                lastWeekRank: {
                  $let: {
                    vars: {
                      rank: {
                        $add: [
                          {
                            $indexOfArray: ['$lastWeekTopUsers._id', '$_id'],
                          },
                          1,
                        ],
                      },
                    },
                    in: {
                      $cond: {
                        if: { $eq: ['$$rank', 0] },
                        then: '>#20',
                        else: '$$rank',
                      },
                    },
                  },
                },
              },
            },
            { $limit: 3 },
          ]
        : [
            // Daily report version - simpler, no rank comparisons
            {
              $match: {
                datetime: {
                  $gte: dayjs(weekEndDate).subtract(24, 'hours').toDate(),
                  $lte: weekEndDate,
                },
                userId: { $exists: true },
              },
            },
            {
              $addFields: {
                userObjectId: { $toObjectId: '$userId' },
              },
            },
            {
              $lookup: {
                from: 'users',
                localField: 'userObjectId',
                foreignField: '_id',
                as: 'userDetails',
              },
            },
            {
              $group: {
                _id: '$userId',
                interactions: { $sum: 1 },
                email: {
                  $first: {
                    $cond: [
                      { $gt: [{ $size: '$userDetails' }, 0] },
                      { $arrayElemAt: ['$userDetails.email', 0] },
                      '$userEmail',
                    ],
                  },
                },
              },
            },
            { $sort: { interactions: -1 } },
            { $limit: 20 },
            {
              $project: {
                _id: 1,
                email: 1,
                interactions: 1,
              },
            },
          ],
      topOrganizations: [
        {
          $match: {
            datetime: { $gte: weekStartDate, $lte: weekEndDate },
            userOrganization: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: '$userOrganization',
            events: { $sum: 1 },
          },
        },
        { $sort: { events: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from: 'counterlogs',
            pipeline: [
              {
                $match: {
                  datetime: {
                    $gte: lastWeekStart,
                    $lte: lastWeekEnd,
                  },
                  userOrganization: { $exists: true, $ne: null },
                },
              },
              {
                $group: {
                  _id: '$userOrganization',
                  events: { $sum: 1 },
                },
              },
              { $sort: { events: -1 } },
              { $limit: 10 },
            ],
            as: 'lastWeekTopOrgs',
          },
        },
        {
          $project: {
            name: '$_id',
            events: 1,
            rankChange: {
              $let: {
                vars: {
                  currentRank: { $add: [{ $indexOfArray: ['$ROOT.topOrganizations._id', '$_id'] }, 1] },
                  lastWeekRank: {
                    $add: [
                      {
                        $indexOfArray: ['$lastWeekTopOrgs._id', '$_id'],
                      },
                      1,
                    ],
                  },
                },
                in: {
                  $switch: {
                    branches: [
                      {
                        case: { $eq: ['$$lastWeekRank', 0] },
                        then: 'new',
                      },
                      {
                        case: { $eq: ['$$currentRank', '$$lastWeekRank'] },
                        then: 'same',
                      },
                      {
                        case: { $gt: ['$$currentRank', '$$lastWeekRank'] },
                        then: 'down',
                      },
                      {
                        case: { $lt: ['$$currentRank', '$$lastWeekRank'] },
                        then: 'up',
                      },
                    ],
                    default: 'same',
                  },
                },
              },
            },
            lastWeekRank: {
              $let: {
                vars: {
                  rank: {
                    $add: [
                      {
                        $indexOfArray: ['$lastWeekTopOrgs._id', '$_id'],
                      },
                      1,
                    ],
                  },
                },
                in: {
                  $cond: {
                    if: { $eq: ['$$rank', 0] },
                    then: '>#10',
                    else: '$$rank',
                  },
                },
              },
            },
          },
        },
        { $limit: 3 },
      ],
      // Usage breakdown by request surface (web/cli/api/agent/system) for the
      // current period. Reads `metadata.source` set by completion-emitting
      // events (Model Started, Completion API Completed/Failed). Events
      // without `metadata.source` (legacy or non-AI counters) are excluded so
      // the breakdown only reflects AI-traffic surfaces.
      usageBySource: [
        {
          $match: {
            datetime: { $gte: weekStartDate, $lte: weekEndDate },
            'metadata.source': { $exists: true },
          },
        },
        {
          $group: {
            _id: '$metadata.source',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ],
      // Peak activity tracking for current week
      peakActivity: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        // Daily peaks
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$datetime' } },
              dayOfWeek: { $dayOfWeek: '$datetime' },
            },
            totalEvents: { $sum: 1 },
          },
        },
        { $sort: { totalEvents: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: null,
            peakDay: {
              date: '$_id.date',
              dayOfWeek: '$_id.dayOfWeek',
              totalEvents: '$totalEvents',
            },
          },
        },
      ],
      // Peak hours for current week
      peakHours: [
        {
          $match: {
            datetime: {
              $gte: weekStartDate,
              $lte: weekEndDate,
            },
          },
        },
        {
          $group: {
            _id: {
              hour: { $hour: '$datetime' },
              date: { $dateToString: { format: '%Y-%m-%d', date: '$datetime' } },
            },
            events: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: '$_id.hour',
            avgEvents: { $avg: '$events' },
          },
        },
        { $sort: { avgEvents: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: null,
            peakHour: {
              hour: '$_id',
              avgEvents: '$avgEvents',
            },
          },
        },
      ],
      // Last week's peak activity
      lastWeekPeakDay: [
        {
          $match: {
            datetime: {
              $gte: lastWeekStart,
              $lte: lastWeekEnd,
            },
          },
        },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$datetime' } },
              dayOfWeek: { $dayOfWeek: '$datetime' },
            },
            totalEvents: { $sum: 1 },
          },
        },
        { $sort: { totalEvents: -1 } },
        { $limit: 1 },
      ],
      // Last week's peak hours
      lastWeekPeakHours: [
        {
          $match: {
            datetime: {
              $gte: lastWeekStart,
              $lte: lastWeekEnd,
            },
          },
        },
        {
          $group: {
            _id: {
              hour: { $hour: '$datetime' },
              date: { $dateToString: { format: '%Y-%m-%d', date: '$datetime' } },
            },
            events: { $sum: 1 },
          },
        },
        {
          $group: {
            _id: '$_id.hour',
            avgEvents: { $avg: '$events' },
          },
        },
        { $sort: { avgEvents: -1 } },
        { $limit: 1 },
      ],
    };

    // Add monthly metrics only for weekly reports
    if (isWeeklyReport) {
      facetStages.thisMonth = [
        {
          $match: {
            datetime: {
              $gte: monthStart,
              $lte: monthEnd,
            },
          },
        },
        {
          $group: {
            _id: '$counterName',
            count: { $sum: 1 },
          },
        },
      ];

      facetStages.lastMonth = [
        {
          $match: {
            datetime: {
              $gte: lastMonthStart,
              $lte: lastMonthEnd,
            },
          },
        },
        {
          $group: {
            _id: '$counterName',
            count: { $sum: 1 },
          },
        },
      ];
    }

    // Convert facet stages to DocumentDB-compatible format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convertedFacetStages: any = {};
    Object.entries(facetStages).forEach(([key, stages]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      convertedFacetStages[key] = convertPipelineForDocumentDB(stages as any[]);
    });

    // Execute the aggregation with DocumentDB compatibility
    const result = await executeFacetCompatible(
      this.model,
      [], // No base pipeline for this aggregation
      convertedFacetStages
    );

    // Process the results to match the expected format (similar to the original $project stage)
    if (result && result.length > 0) {
      const facetData = result[0];

      // Apply the same transformations as the original $project stage
      const processedResult = [
        {
          thisWeek: facetData.thisWeek || [],
          lastWeek: facetData.lastWeek || [],
          thisMonth: facetData.thisMonth || [],
          lastMonth: facetData.lastMonth || [],
          allUsers: facetData.allUsers || [],
          internalUsers: facetData.internalUsers || [],
          topUsers: facetData.topUsers || [],
          topModels: facetData.topModels || [],
          topOrganizations: facetData.topOrganizations || [],
          peakDay:
            facetData.peakActivity && facetData.peakActivity[0]
              ? {
                  date: facetData.peakActivity[0].peakDay?.date || '',
                  totalEvents: facetData.peakActivity[0].peakDay?.totalEvents || 0,
                }
              : undefined,
          peakTime:
            facetData.peakHours && facetData.peakHours[0]
              ? {
                  hour: facetData.peakHours[0].peakHour?.hour || 0,
                  avgEvents: facetData.peakHours[0].peakHour?.avgEvents || 0,
                }
              : undefined,
          lastWeekPeakDay:
            facetData.lastWeekPeakDay && facetData.lastWeekPeakDay[0]
              ? {
                  date: facetData.lastWeekPeakDay[0]._id?.date || '',
                  totalEvents: facetData.lastWeekPeakDay[0].totalEvents || 0,
                }
              : undefined,
          lastWeekPeakTime:
            facetData.lastWeekPeakHours && facetData.lastWeekPeakHours[0]
              ? {
                  hour: facetData.lastWeekPeakHours[0]._id || 0,
                  avgEvents: facetData.lastWeekPeakHours[0].avgEvents || 0,
                }
              : undefined,
          usageBySource: facetData.usageBySource || [],
          hasData: facetData.thisWeek && facetData.thisWeek.length > 0,
        },
      ];

      return processedResult;
    }

    return result;
  }

  async findRecentByUserIdAndCounterNamesAndHasMetadata(
    userId: string,
    counterNames: string[]
  ): Promise<ICounterLogDocument[]> {
    const result = await this.model
      .find({
        userId,
        metadata: { $exists: true },
        counterName: { $in: counterNames },
      })
      .sort({ createdAt: -1 })
      .limit(10);

    return result;
  }
}

const CounterLogSchema = new mongoose.Schema<ICounterLog>(
  {
    userId: { type: String, required: true },
    userName: { type: String, required: true },
    userTags: { type: [String], default: [] },
    userLevel: { type: String, required: true },
    userOrganization: { type: String, default: '' },
    counterName: { type: String, required: true },
    counterTags: { type: [String], default: [] },
    counterValue: { type: Number, required: true },
    datetime: { type: Date, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
    statics: {
      findRecentByUserIdAndHasMetadata: async function (userId: string): Promise<ICounterLog[]> {
        const result = await this.find({ userId, metadata: { $exists: true } })
          .sort({ createdAt: -1 })
          .limit(10);

        return result;
      },
      findAllWithUserByDate: async function (date: string): Promise<(ICounterLog & { user: IUserDocument })[]> {
        const pipeline = [
          {
            $match: {
              datetime: {
                $gte: new Date(date),
                $lt: new Date(new Date(date).setDate(new Date(date).getDate() + 1)),
              },
            },
          },
          {
            $addFields: {
              userObjectId: { $toObjectId: '$userId' },
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: 'userObjectId',
              foreignField: '_id',
              as: 'user',
            },
          },
          {
            $unwind: {
              path: '$user',
              preserveNullAndEmptyArrays: true,
            },
          },
        ];

        const result = this.aggregate(convertPipelineForDocumentDB(pipeline));
        return result;
      },
      findAllWithUserByDateRange: async function (
        startDate: string,
        endDate: string
      ): Promise<(ICounterLog & { user: IUserDocument })[]> {
        const start = dayjs(startDate).startOf('day').toDate();
        const end = dayjs(endDate).endOf('day').toDate();

        const pipeline = [
          {
            $match: {
              datetime: {
                $gte: start,
                $lte: end,
              },
            },
          },
          {
            $addFields: {
              userObjectId: { $toObjectId: '$userId' },
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: 'userObjectId',
              foreignField: '_id',
              as: 'user',
            },
          },
          {
            $unwind: {
              path: '$user',
              preserveNullAndEmptyArrays: true,
            },
          },
        ];

        return this.aggregate(convertPipelineForDocumentDB(pipeline));
      },
      findRecentByUserIdAndCounterNamesAndHasMetadata: async function (
        userId: string,
        counterNames: string[]
      ): Promise<ICounterLog[]> {
        const result = await this.find({
          userId,
          metadata: { $exists: true },
          counterName: { $in: counterNames },
        })
          .sort({ createdAt: -1 })
          .limit(10);

        return result;
      },
    },
  }
);

// Add indexes for query optimization
// Main compound index for filtering and sorting
CounterLogSchema.index({ datetime: 1, counterName: 1, userOrganization: 1 });

// Additional index for organization-based queries
CounterLogSchema.index({ userOrganization: 1 });

// Index for time-series analysis
CounterLogSchema.index({ datetime: 1 });

// Index for user activity analysis
CounterLogSchema.index({ userId: 1, datetime: 1, counterName: 1 });

// Add compound index for the specific aggregation (optimizes common aggregation queries)
CounterLogSchema.index({ datetime: 1, counterName: 1, userId: 1 }, { background: true });

// Optimized indexes for report generation
// Model usage metrics
CounterLogSchema.index({
  datetime: 1,
  counterName: 1,
  'metadata.modelName': 1,
});

// Source-breakdown queries for `usageBySource` facet in `metricsByDate`
CounterLogSchema.index({
  datetime: 1,
  'metadata.source': 1,
});

// Report activity metrics
CounterLogSchema.index({
  datetime: 1,
  counterName: 1,
  'metadata.reportId': 1,
  'metadata.title': 1,
});

// User activity and value metrics
CounterLogSchema.index({
  datetime: 1,
  userId: 1,
  counterValue: 1,
});

// Organization activity metrics
CounterLogSchema.index({
  datetime: 1,
  userOrganization: 1,
  counterValue: 1,
});

export const CounterLog =
  (mongoose.models.CounterLog as unknown as ICounterLogModel) ??
  mongoose.model<ICounterLog, ICounterLogModel>('CounterLog', CounterLogSchema);
export default CounterLog;

export const counterLogRepository = new CounterLogRepository(CounterLog);
