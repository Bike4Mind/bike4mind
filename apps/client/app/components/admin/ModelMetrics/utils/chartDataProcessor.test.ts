import { describe, it, expect } from 'vitest';
import { processChartData } from './chartDataProcessor';
import { ModelMetric } from '../types';

// Timestamps are deliberately written without a zone so dayjs reads them as local time,
// which is also how the bucket labels are formatted. That keeps every expectation below
// true under any TZ the suite happens to run in.
const metric = (timestamp: string, performance: ModelMetric['performance'] = {}, type = 'text'): ModelMetric => ({
  id: timestamp,
  timestamp,
  model: { name: 'test-model', type },
  tokenUsage: {},
  performance,
  session: {},
  status: 'completed',
});

const points = (series: Array<{ data: Array<{ x: string; y: number }> }>) => series[0].data;

describe('processChartData', () => {
  describe('time bucketing', () => {
    it('buckets by the hour, not the minute, inside the 48-hour window', () => {
      const chartData = processChartData([
        metric('2025-09-14T14:05:00', { contextRetrievalTime: 100 }),
        metric('2025-09-14T14:47:00', { contextRetrievalTime: 200 }),
        metric('2025-09-14T15:10:00', { contextRetrievalTime: 900 }),
      ]);

      expect(chartData.granularity).toBe('hourly');
      expect(points(chartData.dailyTrends)).toEqual([
        { x: '09/14 14:00', y: 2 },
        { x: '09/14 15:00', y: 1 },
      ]);
      // Both 14:xx samples land in one bucket, so the average is a real average.
      expect(points(chartData.contextRetrievalTrends)).toEqual([
        { x: '09/14 14:00', y: 150 },
        { x: '09/14 15:00', y: 900 },
      ]);
    });

    it('buckets by the day once the data spans more than 48 hours', () => {
      const chartData = processChartData([
        metric('2025-09-14T14:05:00'),
        metric('2025-09-16T23:00:00'),
        metric('2025-09-16T01:00:00'),
      ]);

      expect(chartData.granularity).toBe('daily');
      expect(points(chartData.dailyTrends)).toEqual([
        { x: '09/14', y: 1 },
        { x: '09/16', y: 2 },
      ]);
    });

    it('picks granularity from the extreme timestamps, not the array ends', () => {
      // A user-sorted table (by cost, model, ...) can put any row first or last. The
      // 4-day span has to win regardless of which rows those happen to be.
      const wide = [
        metric('2025-09-15T12:00:00'),
        metric('2025-09-13T12:00:00'),
        metric('2025-09-17T12:00:00'),
        metric('2025-09-15T18:00:00'),
      ];

      expect(processChartData(wide).granularity).toBe('daily');
      expect(points(processChartData(wide).dailyTrends).map(p => p.x)).toEqual(['09/13', '09/15', '09/17']);
    });

    it('produces the same series whatever order the metrics arrive in', () => {
      const metrics = [
        metric('2025-09-14T09:30:00', { firstTokenTime: 300 }),
        metric('2025-09-14T11:15:00', { firstTokenTime: 500 }),
        metric('2025-09-14T09:45:00', { firstTokenTime: 700 }),
      ];

      const forwards = processChartData(metrics);
      const backwards = processChartData([...metrics].reverse());

      expect(points(backwards.firstTokenTrends)).toEqual(points(forwards.firstTokenTrends));
      expect(points(forwards.firstTokenTrends)).toEqual([
        { x: '09/14 09:00', y: 500 },
        { x: '09/14 11:00', y: 500 },
      ]);
    });

    it('orders daily buckets across a year boundary', () => {
      // The labels carry no year, so ordering cannot come from re-parsing them.
      const chartData = processChartData([
        metric('2026-01-02T10:00:00'),
        metric('2025-12-30T10:00:00'),
        metric('2026-01-01T10:00:00'),
        metric('2025-12-31T10:00:00'),
      ]);

      expect(points(chartData.dailyTrends).map(p => p.x)).toEqual(['12/30', '12/31', '01/01', '01/02']);
    });

    it('keeps two years that share one MM/DD label apart', () => {
      // The label is not unique, so grouping on it merged the two days into one point:
      // the counts summed and the averages ran together. Grouping is on the bucket instant.
      const chartData = processChartData([
        metric('2025-03-04T10:00:00', { contextRetrievalTime: 100 }),
        metric('2026-03-04T10:00:00', { contextRetrievalTime: 900 }),
      ]);

      expect(points(chartData.dailyTrends)).toEqual([
        { x: '03/04', y: 1 },
        { x: '03/04', y: 1 },
      ]);
      expect(points(chartData.contextRetrievalTrends)).toEqual([
        { x: '03/04', y: 100 },
        { x: '03/04', y: 900 },
      ]);
    });

    it('returns empty series for no metrics', () => {
      const chartData = processChartData([]);

      expect(points(chartData.dailyTrends)).toEqual([]);
      expect(points(chartData.charactersPerSecondTrends)).toEqual([]);
      expect(chartData.modelUsageData).toEqual([]);
      expect(chartData.granularity).toBe('hourly');
    });
  });

  describe('series membership', () => {
    it('counts only text models with a positive streaming speed', () => {
      const chartData = processChartData([
        metric('2025-09-14T10:00:00', { streamingPerformance: { charsPerSecond: 80 } }),
        metric('2025-09-14T10:30:00', { streamingPerformance: { charsPerSecond: 120 } }),
        metric('2025-09-14T10:40:00', { streamingPerformance: { charsPerSecond: 0 } }),
        metric('2025-09-14T10:50:00', { streamingPerformance: { charsPerSecond: 999 } }, 'image'),
        metric('2025-09-14T10:55:00', {}),
      ]);

      expect(points(chartData.charactersPerSecondTrends)).toEqual([{ x: '09/14 10:00', y: 100 }]);
    });

    it('keeps a zero pickup time but drops a negative one', () => {
      const chartData = processChartData([
        metric('2025-09-14T10:00:00', { processPickupTime: 0 }),
        metric('2025-09-14T10:10:00', { processPickupTime: 400 }),
        metric('2025-09-14T10:20:00', { processPickupTime: -1 }),
      ]);

      expect(points(chartData.processPickupTrends)).toEqual([{ x: '09/14 10:00', y: 200 }]);
    });

    it('omits a bucket entirely when no metric in it reported the field', () => {
      const chartData = processChartData([
        metric('2025-09-14T10:00:00', { contextRetrievalTime: 50 }),
        metric('2025-09-14T11:00:00', {}),
      ]);

      expect(points(chartData.contextRetrievalTrends)).toEqual([{ x: '09/14 10:00', y: 50 }]);
    });
  });
});
