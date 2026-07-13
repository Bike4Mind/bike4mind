import { baseApi } from '@server/middlewares/baseApi';
import { Request, Response } from 'express';
import { CounterLog } from '@bike4mind/database';
import { dayjs } from '@bike4mind/common';
import { ensureAdmin } from '@server/utils/errors';

interface AggregateQueryParams {
  startDate?: string;
  endDate?: string;
  groupBy?: 'day' | 'hour';
}

interface DailyAggregation {
  date: string;
  totalEvents: number;
  uniqueUsers: number;
  eventsByType: {
    type: string;
    count: number;
  }[];
  eventsByOrganization?: {
    organization: string;
    count: number;
  }[];
}

const handler = baseApi().get(async (req: Request<{}, unknown, unknown, AggregateQueryParams>, res: Response) => {
  // Cross-tenant analytics (event volumes grouped by organization). Admin-only.
  ensureAdmin(req.user?.isAdmin);

  const { startDate, endDate, groupBy = 'day' } = req.query;

  // Default to last 30 days if no dates provided
  const end = endDate ? dayjs(endDate).endOf('day').toDate() : dayjs().endOf('day').toDate();
  const start = startDate
    ? dayjs(startDate).startOf('day').toDate()
    : dayjs(end).subtract(30, 'days').startOf('day').toDate();

  // Build aggregation pipeline
  const dateFormat = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';

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
      $group: {
        _id: {
          date: { $dateToString: { format: dateFormat, date: '$datetime' } },
        },
        totalEvents: { $sum: 1 },
        uniqueUsers: { $addToSet: '$userId' },
        events: {
          $push: {
            type: '$counterName',
            organization: '$userOrganization',
          },
        },
      },
    },
    {
      $project: {
        date: '$_id.date',
        totalEvents: 1,
        uniqueUsers: { $size: '$uniqueUsers' },
        events: 1,
        _id: 0,
      },
    },
    {
      $sort: { date: 1 as const },
    },
  ];

  const results = await CounterLog.aggregate(pipeline);

  // Post-process to group events by type and organization within each day
  const aggregatedData: DailyAggregation[] = results.map((result: any) => {
    // Group events by type
    const eventsByType = result.events.reduce((acc: Record<string, number>, event: any) => {
      acc[event.type] = (acc[event.type] || 0) + 1;
      return acc;
    }, {});

    // Group events by organization
    const eventsByOrganization = result.events.reduce((acc: Record<string, number>, event: any) => {
      if (event.organization) {
        acc[event.organization] = (acc[event.organization] || 0) + 1;
      }
      return acc;
    }, {});

    return {
      date: result.date,
      totalEvents: result.totalEvents,
      uniqueUsers: result.uniqueUsers,
      eventsByType: Object.entries(eventsByType)
        .map(([type, count]) => ({ type, count: count as number }))
        .sort((a, b) => b.count - a.count),
      eventsByOrganization: Object.entries(eventsByOrganization)
        .map(([organization, count]) => ({ organization, count: count as number }))
        .sort((a, b) => b.count - a.count),
    };
  });

  return res.status(200).json(aggregatedData);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
