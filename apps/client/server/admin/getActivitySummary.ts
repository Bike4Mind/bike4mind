import { CounterLog } from '@bike4mind/database';
import { UserApiKeyEvents } from '@bike4mind/common';
import type { AdminActivitySummary } from '@client/shared/adminActivitySummary';
import { categorizeEvent } from './categorizeEvent';

const DAY_MS = 24 * 60 * 60 * 1000;
// Route template stamped as metadata.endpoint by apiKeyAuth (pages/api/overwatch/v1/events.ts).
const OVERWATCH_INGEST_ENDPOINT = '/api/overwatch/v1/events';
const WINDOW_DAYS = 7;

type DailyEventCount = { _id: { date: string; eventName: string }; count: number };

export async function getActivitySummary(now = new Date()): Promise<AdminActivitySummary> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStart = new Date(today - (WINDOW_DAYS - 1) * DAY_MS);
  const dailyCounts = await CounterLog.aggregate<DailyEventCount>([
    {
      $match: {
        datetime: { $gte: windowStart, $lte: now },
        counterName: { $type: 'string' },
        // apiKeyAuth no longer emits these; this drops rows written before it stopped. Unindexed
        // field, so delete this clause once those rows age out of the window (a week after release).
        $nor: [{ counterName: UserApiKeyEvents.USED, 'metadata.endpoint': OVERWATCH_INGEST_ENDPOINT }],
      },
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$datetime', timezone: 'UTC' } },
          eventName: '$counterName',
        },
        count: { $sum: 1 },
      },
    },
  ]);

  const days = new Map<string, number>(
    Array.from(
      { length: WINDOW_DAYS },
      (_, index) => [new Date(windowStart.getTime() + index * DAY_MS).toISOString().slice(0, 10), 0] as const
    )
  );
  const categories = new Map<string, number>();
  const events = new Map<string, number>();
  let totalEvents = 0;

  for (const {
    _id: { date, eventName },
    count,
  } of dailyCounts) {
    days.set(date, (days.get(date) ?? 0) + count);
    const category = categorizeEvent(eventName);
    categories.set(category, (categories.get(category) ?? 0) + count);
    events.set(eventName, (events.get(eventName) ?? 0) + count);
    totalEvents += count;
  }

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    totalEvents,
    timeSeriesData: [...days].map(([date, count]) => ({ date, count })),
    categoryBreakdown: [...categories]
      .map(([category, count]) => ({ category, count, percentage: totalEvents ? (count / totalEvents) * 100 : 0 }))
      .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)),
    topEvents: [...events]
      .map(([eventName, count]) => ({ eventName, count, category: categorizeEvent(eventName) }))
      .sort((left, right) => right.count - left.count || left.eventName.localeCompare(right.eventName))
      .slice(0, 10),
  };
}
