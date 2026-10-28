import { Logger } from '@bike4mind/observability';
import { secureParameters } from '@bike4mind/utils';
import { UserActivityMetrics, KpiMetrics } from './types';
import { calculatePercentageChange } from './utils';
import { z } from 'zod';
import { AggregationResult, ICounterLogRepository, TopUserResult, type CompletionSource } from '@bike4mind/common';
import dayjs from 'dayjs';

export interface CounterMetrics extends KpiMetrics {
  last24h: number;
  weeklyTotal: number;
  lastWeekTotal: number;
  monthlyTotal: number;
  lastMonthTotal: number;
  weekOverWeekChange: number;
  monthOverMonthChange: number;
  fourWeekAverage: number;
  fourWeekAverageChange: number;
}

const getCounterTotalsForLast24HoursSchema = z.object({
  date: z.string(),
  endDate: z.string().optional(),
});

type GetCounterTotalsForLast24HoursParameters = z.infer<typeof getCounterTotalsForLast24HoursSchema>;

interface GetCounterTotalsForLast24HoursAdapters {
  db: {
    counterLogs: ICounterLogRepository;
  };
  logger: Logger;
}

export async function getCounterTotalsForLast24Hours(
  parameters: GetCounterTotalsForLast24HoursParameters,
  adapters: GetCounterTotalsForLast24HoursAdapters
): Promise<{
  metrics: Record<string, CounterMetrics>;
  userActivity: UserActivityMetrics;
  peakDay?: { date: string; totalEvents: number };
  peakTime?: { hour: number; avgEvents: number };
  lastWeekPeakDay?: { date: string; totalEvents: number };
  lastWeekPeakTime?: { hour: number; avgEvents: number };
  topOrganizations?: Array<{
    name: string;
    events: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
  /**
   * Counter-log events grouped by `metadata.source` for the current period.
   * Sorted descending by count. Empty array when no events carry source yet.
   */
  usageBySource?: Array<{ source: CompletionSource; count: number }>;
}> {
  const { db, logger } = adapters;
  const { date, endDate } = secureParameters(parameters, getCounterTotalsForLast24HoursSchema);

  try {
    logger.info('Starting metrics calculation', { date, endDate });

    // Weekly reports pass the range as date (first day) .. endDate (last day); daily reports a
    // single date. metricsByDate owns the UTC windows for both (CounterLogModel.ts).
    const isWeeklyReport = !!endDate;
    const reportEndDay = dayjs.utc(endDate || date).format('YYYY-MM-DD');
    const reportStartDay = isWeeklyReport ? dayjs.utc(date).format('YYYY-MM-DD') : undefined;

    logger.info('Running aggregation pipeline', { reportStartDay, reportEndDay, isWeeklyReport });

    // Single aggregation pipeline for all metrics
    const result = await db.counterLogs.metricsByDate(reportEndDay, reportStartDay).catch(error => {
      logger.error('Aggregation pipeline failed', { error });
      throw error;
    });
    logger.info('Aggregation pipeline result', { result });

    if (!result || !Array.isArray(result) || result.length === 0) {
      logger.error('No results returned from aggregation');
      throw new Error('No results from aggregation pipeline');
    }

    logger.info('Processing aggregation results');

    const [aggregationResult] = result;
    if (!aggregationResult) {
      logger.error('Invalid aggregation result format');
      throw new Error('Invalid aggregation result format');
    }

    // Convert aggregation results to metrics format
    const metrics: Record<string, CounterMetrics> = {};
    const counterNames = new Set([
      ...(aggregationResult.last24h?.map((x: AggregationResult) => x._id) || []),
      ...(aggregationResult.thisWeek?.map((x: AggregationResult) => x._id) || []),
      ...(aggregationResult.lastWeek?.map((x: AggregationResult) => x._id) || []),
      ...(aggregationResult.thisMonth?.map((x: AggregationResult) => x._id) || []),
      ...(aggregationResult.lastMonth?.map((x: AggregationResult) => x._id) || []),
    ]);

    counterNames.forEach((name: string) => {
      const last24hCount = isWeeklyReport
        ? 0
        : aggregationResult.last24h?.find((x: AggregationResult) => x._id === name)?.count || 0;
      const weeklyTotal = aggregationResult.thisWeek?.find((x: AggregationResult) => x._id === name)?.count || 0;
      const lastWeekTotal = aggregationResult.lastWeek?.find((x: AggregationResult) => x._id === name)?.count || 0;
      const monthlyTotal = aggregationResult.thisMonth?.find((x: AggregationResult) => x._id === name)?.count || 0;
      const lastMonthTotal = aggregationResult.lastMonth?.find((x: AggregationResult) => x._id === name)?.count || 0;

      metrics[name] = {
        last24h: last24hCount,
        weeklyTotal,
        lastWeekTotal,
        monthlyTotal,
        lastMonthTotal,
        weekOverWeekChange: calculatePercentageChange(weeklyTotal, lastWeekTotal),
        monthOverMonthChange: calculatePercentageChange(monthlyTotal, lastMonthTotal),
        fourWeekAverage: monthlyTotal / 4,
        fourWeekAverageChange: calculatePercentageChange(weeklyTotal, monthlyTotal / 4),
      };
    });

    const totalUniqueUsers = aggregationResult.allUsers?.[0]?.count || 0;
    const internalUsers = aggregationResult.internalUsers?.[0]?.count || 0;

    logger.info('Metrics calculation completed', {
      counterCount: counterNames.size,
      totalUniqueUsers,
      internalUsers,
    });

    return {
      metrics,
      userActivity: {
        totalUniqueUsers,
        internalUsers,
        externalUsers: totalUniqueUsers - internalUsers,
        weeklyActiveUsers: aggregationResult.weeklyActiveUsers?.[0]?.count || 0,
        topUsers: (aggregationResult.topUsers || []).map((user: TopUserResult) => ({
          _id: user._id,
          email: user.email || user._id,
          interactions: user.interactions,
          creditsSpent: user.creditsSpent || 0,
          isNew: user.isNew || false,
          rankChange: user.rankChange || 'same',
          lastWeekRank: user.lastWeekRank || '>#20',
        })),
        topModels: (aggregationResult.topModels || []).map(model => ({
          modelName: model.modelName,
          count: model.count,
          rankChange: model.rankChange || 'same',
          lastWeekRank: model.lastWeekRank || '>#10',
        })),
      },
      peakDay: aggregationResult.peakDay,
      peakTime: aggregationResult.peakTime,
      lastWeekPeakDay: aggregationResult.lastWeekPeakDay,
      lastWeekPeakTime: aggregationResult.lastWeekPeakTime,
      topOrganizations: (aggregationResult.topOrganizations || []).map(org => ({
        name: org.name,
        events: org.events,
        rankChange: org.rankChange || 'same',
        lastWeekRank: org.lastWeekRank || '>#10',
      })),
      usageBySource: (aggregationResult.usageBySource || []).map(({ _id, count }) => ({
        source: _id,
        count,
      })),
    };
  } catch (error) {
    logger.error('Failed to calculate metrics', { error });
    throw error;
  }
}
