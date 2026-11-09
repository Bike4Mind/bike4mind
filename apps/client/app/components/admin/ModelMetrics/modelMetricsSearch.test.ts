import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { resolvePeriod } from './modelMetricsSearch';

const now = dayjs('2026-11-09T15:30:00.000Z');

describe('resolvePeriod', () => {
  it('spans the last 24 hours up to now', () => {
    expect(resolvePeriod('24h', now)).toEqual({
      dateFrom: '2026-11-08T15:30:00.000Z',
      dateTo: '2026-11-09T15:30:00.000Z',
    });
  });

  it('spans 7 and 30 days', () => {
    expect(resolvePeriod('7d', now).dateFrom).toBe(now.subtract(7, 'day').toISOString());
    expect(resolvePeriod('30d', now).dateFrom).toBe(now.subtract(30, 'day').toISOString());
  });

  it('starts today at the start of the day', () => {
    const { dateFrom, dateTo } = resolvePeriod('today', now);
    expect(dateFrom).toBe(now.startOf('day').toISOString());
    expect(dateTo).toBe(now.toISOString());
  });

  it('gives no bounds for an unset or unknown period', () => {
    expect(resolvePeriod('', now)).toEqual({});
    expect(resolvePeriod('bogus', now)).toEqual({});
  });
});
