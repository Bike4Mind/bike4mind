import { Request } from 'express';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { CounterLog } from '@bike4mind/database';
import { type CompletionSource, type UsageBySourceResponse } from '@bike4mind/common';
import { z } from 'zod';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

const QuerySchema = z.object({
  // Lookback window in hours. Defaults to 168 (7 days). Clamp keeps this from
  // becoming an accidental "scan the whole collection" foot-gun.
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 90)
    .optional(),
});

type UsageBySourceQuery = z.infer<typeof QuerySchema>;

/**
 * Admin endpoint: counter-log activity grouped by `metadata.source`.
 * Surfaces both event count and distinct-user count per surface
 * (web / cli / api / agent / system) so admins can see *how many users*
 * each surface is serving, not just total activity volume.
 *
 * Reads from CounterLog rather than CreditTransaction because the analytics
 * layer is the right home for "who did what" - the ledger is for $.
 */
const handler = baseApi().get(async (req: Request<{}, {}, {}, UsageBySourceQuery>, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const { hours = 168 } = QuerySchema.parse(req.query);
  const windowEnd = dayjs().utc();
  const windowStart = windowEnd.subtract(hours, 'hour');

  const result = await CounterLog.aggregate<{ _id: CompletionSource; events: number; uniqueUsers: number }>([
    {
      $match: {
        datetime: { $gte: windowStart.toDate(), $lte: windowEnd.toDate() },
        'metadata.source': { $exists: true },
      },
    },
    {
      $group: {
        _id: '$metadata.source',
        events: { $sum: 1 },
        // Exclude null/missing userIds so system/cron-emitted events don't
        // inflate uniqueUsers by collapsing all anonymous rows into one bucket.
        userIds: {
          $addToSet: { $cond: [{ $ifNull: ['$userId', false] }, '$userId', '$$REMOVE'] },
        },
      },
    },
    {
      $project: {
        events: 1,
        uniqueUsers: { $size: '$userIds' },
      },
    },
    { $sort: { events: -1 } },
  ]);

  const response: UsageBySourceResponse = {
    windowHours: hours,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    buckets: result.map(r => ({
      source: r._id,
      events: r.events,
      uniqueUsers: r.uniqueUsers,
    })),
  };

  return res.json(response);
});

export default handler;
