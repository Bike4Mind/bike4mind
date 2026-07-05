import dayjs from 'dayjs';
import { ModelMetric, ChartData } from '../types';
import { getDisplayName } from './formatters';

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

  // Determine time granularity based on data range
  // If data spans <= 48 hours, use hourly granularity; otherwise use daily
  const timeRange =
    filteredMetrics.length > 0
      ? dayjs(filteredMetrics[0].timestamp).diff(dayjs(filteredMetrics[filteredMetrics.length - 1].timestamp), 'hour')
      : 0;
  const useHourlyGranularity = Math.abs(timeRange) <= 48;
  const dateFormat = useHourlyGranularity ? 'MM/DD HH:mm' : 'MM/DD';

  // Daily/Hourly usage trends
  const dailyUsage = filteredMetrics.reduce(
    (acc, metric) => {
      const date = dayjs(metric.timestamp).format(dateFormat);
      if (!acc[date]) {
        acc[date] = { x: date, y: 0 };
      }
      acc[date].y += 1;
      return acc;
    },
    {} as Record<string, any>
  );

  const dailyTrends = [
    {
      id: 'requests',
      data: Object.values(dailyUsage).sort(
        (a: any, b: any) => dayjs(a.x, dateFormat).unix() - dayjs(b.x, dateFormat).unix()
      ),
    },
  ];

  // Context retrieval time trends - group by date/hour and calculate average context retrieval time
  const contextRetrievalByDate = filteredMetrics.reduce(
    (acc, metric) => {
      const date = dayjs(metric.timestamp).format(dateFormat);
      const contextTime = metric.performance?.contextRetrievalTime;

      if (contextTime !== undefined && contextTime !== null) {
        if (!acc[date]) {
          acc[date] = { times: [], x: date };
        }
        acc[date].times.push(contextTime);
      }
      return acc;
    },
    {} as Record<string, { times: number[]; x: string }>
  );

  const contextRetrievalTrends = [
    {
      id: 'context-retrieval',
      data: Object.values(contextRetrievalByDate)
        .map(({ times, x }) => ({
          x,
          y: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        }))
        .sort((a, b) => dayjs(a.x, dateFormat).unix() - dayjs(b.x, dateFormat).unix()),
    },
  ];

  // First token time trends - group by date/hour and calculate average first token time
  const firstTokenByDate = filteredMetrics.reduce(
    (acc, metric) => {
      const date = dayjs(metric.timestamp).format(dateFormat);
      const firstTokenTime = metric.performance?.firstTokenTime;

      if (firstTokenTime !== undefined && firstTokenTime !== null) {
        if (!acc[date]) {
          acc[date] = { times: [], x: date };
        }
        acc[date].times.push(firstTokenTime);
      }
      return acc;
    },
    {} as Record<string, { times: number[]; x: string }>
  );

  const firstTokenTrends = [
    {
      id: 'first-token',
      data: Object.values(firstTokenByDate)
        .map(({ times, x }) => ({
          x,
          y: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        }))
        .sort((a, b) => dayjs(a.x, dateFormat).unix() - dayjs(b.x, dateFormat).unix()),
    },
  ];

  // Characters per second trends - only for text-type models with streaming performance data
  const charactersPerSecondByDate = filteredMetrics.reduce(
    (acc, metric) => {
      const date = dayjs(metric.timestamp).format(dateFormat);
      const modelType = metric.model?.type;
      const charsPerSecond = metric.performance?.streamingPerformance?.charsPerSecond;

      // Only include text-type models with valid streaming performance data
      if (modelType === 'text' && charsPerSecond !== undefined && charsPerSecond !== null && charsPerSecond > 0) {
        if (!acc[date]) {
          acc[date] = { speeds: [], x: date };
        }
        acc[date].speeds.push(charsPerSecond);
      }
      return acc;
    },
    {} as Record<string, { speeds: number[]; x: string }>
  );

  const charactersPerSecondTrends = [
    {
      id: 'chars-per-second',
      data:
        Object.values(charactersPerSecondByDate).length > 0
          ? Object.values(charactersPerSecondByDate)
              .map(({ speeds, x }) => ({
                x,
                y: speeds.length > 0 ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0,
              }))
              .sort((a, b) => dayjs(a.x, dateFormat).unix() - dayjs(b.x, dateFormat).unix())
          : [],
    },
  ];

  // Process pickup time trends - group by date/hour and calculate average pickup time
  const processPickupByDate = filteredMetrics.reduce(
    (acc, metric) => {
      const date = dayjs(metric.timestamp).format(dateFormat);
      const pickupTime = metric.performance?.processPickupTime;

      if (pickupTime !== undefined && pickupTime !== null && pickupTime >= 0) {
        if (!acc[date]) {
          acc[date] = { times: [], x: date };
        }
        acc[date].times.push(pickupTime);
      }
      return acc;
    },
    {} as Record<string, { times: number[]; x: string }>
  );

  const processPickupTrends = [
    {
      id: 'process-pickup',
      data: Object.values(processPickupByDate)
        .map(({ times, x }) => ({
          x,
          y: times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
        }))
        .sort((a, b) => dayjs(a.x, dateFormat).unix() - dayjs(b.x, dateFormat).unix()),
    },
  ];

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
