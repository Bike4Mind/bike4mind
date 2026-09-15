import { describe, it, expect } from 'vitest';
import { buildLatencyTimeSeries, buildErrorRateSeries } from '../chartDataProcessor';
import type { HealthCheckHistoryPoint } from '../../types';

function makeCheck(overrides: Partial<HealthCheckHistoryPoint> = {}): HealthCheckHistoryPoint {
  return {
    status: 'healthy',
    latencyMs: 100,
    statusCode: 200,
    error: null,
    checkedAt: '2024-01-15T12:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

describe('buildLatencyTimeSeries', () => {
  it('returns empty array for empty input', () => {
    expect(buildLatencyTimeSeries([])).toEqual([]);
  });

  it('computes p50 and p95 for a single bucket', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', latencyMs: 100 }),
      makeCheck({ checkedAt: '2024-01-15T12:10:00.000Z', latencyMs: 200 }),
      makeCheck({ checkedAt: '2024-01-15T12:20:00.000Z', latencyMs: 300 }),
    ];

    const result = buildLatencyTimeSeries(checks, 30);
    expect(result).toHaveLength(1);
    expect(result[0].p50).toBe(200);
    expect(result[0].p95).toBe(300);
  });

  it('groups checks into separate time buckets', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', latencyMs: 100 }),
      makeCheck({ checkedAt: '2024-01-15T12:45:00.000Z', latencyMs: 200 }),
      makeCheck({ checkedAt: '2024-01-15T13:15:00.000Z', latencyMs: 300 }),
    ];

    const result = buildLatencyTimeSeries(checks, 30);
    expect(result).toHaveLength(3);
  });

  it('returns buckets in chronological order', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T14:00:00.000Z', latencyMs: 300 }),
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', latencyMs: 100 }),
      makeCheck({ checkedAt: '2024-01-15T13:00:00.000Z', latencyMs: 200 }),
    ];

    const result = buildLatencyTimeSeries(checks, 30);
    expect(result).toHaveLength(3);
    expect(result[0].p50).toBe(100);
    expect(result[1].p50).toBe(200);
    expect(result[2].p50).toBe(300);
  });

  it('handles single check (p50 === p95)', () => {
    const checks = [makeCheck({ checkedAt: '2024-01-15T12:05:00.000Z', latencyMs: 150 })];
    const result = buildLatencyTimeSeries(checks, 30);
    expect(result).toHaveLength(1);
    expect(result[0].p50).toBe(150);
    expect(result[0].p95).toBe(150);
  });
});

describe('buildErrorRateSeries', () => {
  it('returns empty array for empty input', () => {
    expect(buildErrorRateSeries([])).toEqual([]);
  });

  it('counts failures and totals per bucket', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', status: 'healthy' }),
      makeCheck({ checkedAt: '2024-01-15T12:10:00.000Z', status: 'unhealthy' }),
      makeCheck({ checkedAt: '2024-01-15T12:20:00.000Z', status: 'unhealthy' }),
    ];

    const result = buildErrorRateSeries(checks, 60);
    expect(result).toHaveLength(1);
    expect(result[0].failures).toBe(2);
    expect(result[0].total).toBe(3);
  });

  it('separates buckets by time', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', status: 'unhealthy' }),
      makeCheck({ checkedAt: '2024-01-15T13:30:00.000Z', status: 'healthy' }),
    ];

    const result = buildErrorRateSeries(checks, 60);
    expect(result).toHaveLength(2);
    expect(result[0].failures).toBe(1);
    expect(result[1].failures).toBe(0);
  });

  it('returns buckets in chronological order', () => {
    const checks = [
      makeCheck({ checkedAt: '2024-01-15T15:00:00.000Z', status: 'unhealthy' }),
      makeCheck({ checkedAt: '2024-01-15T12:00:00.000Z', status: 'healthy' }),
    ];

    const result = buildErrorRateSeries(checks, 60);
    expect(result).toHaveLength(2);
    expect(result[0].failures).toBe(0);
    expect(result[1].failures).toBe(1);
  });
});
