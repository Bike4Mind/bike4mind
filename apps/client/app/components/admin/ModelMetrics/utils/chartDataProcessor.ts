import dayjs from 'dayjs';
import { ModelMetric, ChartData } from '../types';
import { getDisplayName } from './formatters';

const MS_PER_HOUR = 60 * 60 * 1000;

// Beyond this span the charts switch from hourly to daily buckets.
const MAX_HOURLY_SPAN_MS = 48 * MS_PER_HOUR;

// Bucket labels double as the x-axis ticks, so they stay short and carry no year.
// That makes them unsortable across a year boundary, hence the separate sortKey.
const HOURLY_LABEL = 'MM/DD HH:00';
const DAILY_LABEL = 'MM/DD';

interface Bucket {
  x: string;
  sortKey: number;
}

const toBucket = (timestamp: string, useHourlyGranularity: boolean): Bucket => {
  const start = dayjs(timestamp).startOf(useHourlyGranularity ? 'hour' : 'day');
  return {
    x: start.format(useHourlyGranularity ? HOURLY_LABEL : DAILY_LABEL),
    sortKey: start.valueOf(),
  };
};

/**
 * Averages one numeric field per time bucket. `valueOf` returns null/undefined for
 * metrics that should not contribute to the series at all (not zero, which would
 * drag the average down).
 */
const buildAverageTrend = (
  filteredMetrics: ModelMetric[],
  id: string,
  useHourlyGranularity: boolean,
  valueOf: (metric: ModelMetric) => number | null | undefined
) => {
  const byBucket = filteredMetrics.reduce(
    (acc, metric) => {
      const value = valueOf(metric);
      if (value === undefined || value === null) {
        return acc;
      }
      const { x, sortKey } = toBucket(metric.timestamp, useHourlyGranularity);
      if (!acc[x]) {
        acc[x] = { values: [], x, sortKey };
      }
      acc[x].values.push(value);
      return acc;
    },
    {} as Record<string, { values: number[]; x: string; sortKey: number }>
  );

  return [
    {
      id,
      data: Object.values(byBucket)
        .sort((a, b) => a.sortKey - b.sortKey)
        .map(({ values, x }) => ({
          x,
          y: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
        })),
    },
  ];
};

export const processChartData = (
  filteredMetrics: ModelMetric[],
  modelInfos: any[] = [],
  simplifiedNames: boolean = true
): ChartData => {
  // Model usage distribution
  const modelUsage = filteredMetrics.reduce(
    (acc, metric) => {
      const modelName = metric.model?.name || 'Unknown';
      const displayName = getDisplayName(modelName, modelInfos, simplifiedNames);
      acc[displayName] = (acc[displayName] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const modelUsageData = Object.entries(modelUsage).map(([id, value]) => ({
    id,
    label: id,
    value,
    percentage: filteredMetrics.length > 0 ? ((value / filteredMetrics.length) * 100).toFixed(1) : '0',
  }));

  // Performance by model
  const performanceByModel = filteredMetrics.reduce(
    (acc, metric) => {
      const modelName = metric.model?.name || 'Unknown';
      const displayName = getDisplayName(modelName, modelInfos, simplifiedNames);
      if (!acc[displayName]) {
        acc[displayName] = [];
      }
      if (metric.performance?.totalResponseTime) {
        acc[displayName].push(metric.performance.totalResponseTime);
      }
      return acc;
    },
    {} as Record<string, number[]>
  );

  const performanceData = Object.entries(performanceByModel).map(([model, times]) => ({
    model,
    avgResponseTime: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    count: times.length,
  }));

  // Granularity comes from the span of the data itself, taken from the extreme
  // timestamps rather than the array ends: callers pass user-sortable arrays.
  const span = filteredMetrics.reduce(
    (acc, metric) => {
      const time = dayjs(metric.timestamp).valueOf();
      return { min: Math.min(acc.min, time), max: Math.max(acc.max, time) };
    },
    { min: Infinity, max: -Infinity }
  );
  const useHourlyGranularity = filteredMetrics.length === 0 || span.max - span.min <= MAX_HOURLY_SPAN_MS;

  // Daily/hourly usage trends
  const usageByBucket = filteredMetrics.reduce(
    (acc, metric) => {
      const { x, sortKey } = toBucket(metric.timestamp, useHourlyGranularity);
      if (!acc[x]) {
        acc[x] = { x, y: 0, sortKey };
      }
      acc[x].y += 1;
      return acc;
    },
    {} as Record<string, { x: string; y: number; sortKey: number }>
  );

  const dailyTrends = [
    {
      id: 'requests',
      data: Object.values(usageByBucket)
        .sort((a, b) => a.sortKey - b.sortKey)
        .map(({ x, y }) => ({ x, y })),
    },
  ];

  const contextRetrievalTrends = buildAverageTrend(
    filteredMetrics,
    'context-retrieval',
    useHourlyGranularity,
    metric => metric.performance?.contextRetrievalTime
  );

  const firstTokenTrends = buildAverageTrend(
    filteredMetrics,
    'first-token',
    useHourlyGranularity,
    metric => metric.performance?.firstTokenTime
  );

  // Streaming speed is only meaningful for text models, and a zero reading means
  // the stream never reported progress rather than a genuinely slow response.
  const charactersPerSecondTrends = buildAverageTrend(
    filteredMetrics,
    'chars-per-second',
    useHourlyGranularity,
    metric => {
      const charsPerSecond = metric.performance?.streamingPerformance?.charsPerSecond;
      if (metric.model?.type !== 'text' || !charsPerSecond || charsPerSecond <= 0) {
        return null;
      }
      return charsPerSecond;
    }
  );

  const processPickupTrends = buildAverageTrend(filteredMetrics, 'process-pickup', useHourlyGranularity, metric => {
    const pickupTime = metric.performance?.processPickupTime;
    return pickupTime !== undefined && pickupTime !== null && pickupTime >= 0 ? pickupTime : null;
  });

  return {
    modelUsageData,
    performanceData,
    dailyTrends,
    contextRetrievalTrends,
    firstTokenTrends,
    charactersPerSecondTrends,
    processPickupTrends,
  };
};
export type { ChartData };
