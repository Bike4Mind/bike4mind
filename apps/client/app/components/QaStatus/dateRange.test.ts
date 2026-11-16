import { describe, it, expect } from 'vitest';
import {
  activePreset,
  addDays,
  chartRangeFor,
  parseIsoDay,
  presetRange,
  rangeInstants,
  resolveRange,
  spanDays,
} from './dateRange';

const NOW = new Date(2026, 10, 13, 15);

describe('dateRange', () => {
  it('parses only real YYYY-MM-DD days', () => {
    expect(parseIsoDay('2026-11-13')).toEqual(new Date(2026, 10, 13));
    expect(parseIsoDay('2026-02-30')).toBeNull();
    expect(parseIsoDay('11/13/2026')).toBeNull();
    expect(parseIsoDay(undefined)).toBeNull();
  });

  it('counts days inclusively and adds across months', () => {
    expect(spanDays({ from: '2026-11-13', to: '2026-11-13' })).toBe(1);
    expect(spanDays({ from: '2026-10-25', to: '2026-11-03' })).toBe(10);
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });

  it('builds presets that end today', () => {
    expect(presetRange(1, NOW)).toEqual({ from: '2026-11-13', to: '2026-11-13' });
    expect(presetRange(7, NOW)).toEqual({ from: '2026-11-07', to: '2026-11-13' });
    expect(activePreset({ from: '2026-10-15', to: '2026-11-13' }, NOW)?.id).toBe('30d');
    expect(activePreset({ from: '2026-10-15', to: '2026-11-12' }, NOW)).toBeUndefined();
  });

  it('resolves the URL range: dates, then the older range param, then 7 days', () => {
    expect(resolveRange({ from: '2026-11-01', to: '2026-11-05' }, NOW)).toEqual({
      from: '2026-11-01',
      to: '2026-11-05',
    });
    expect(resolveRange({ from: '2026-11-05', to: '2026-11-01' }, NOW)).toEqual({
      from: '2026-11-01',
      to: '2026-11-05',
    });
    expect(resolveRange({ range: '30d' }, NOW)).toEqual({ from: '2026-10-15', to: '2026-11-13' });
    expect(resolveRange({ from: 'bad', to: '2026-11-05' }, NOW)).toEqual({ from: '2026-11-07', to: '2026-11-13' });
    expect(resolveRange({ from: '2024-01-01', to: '2026-11-13' }, NOW)).toEqual({
      from: '2025-11-13',
      to: '2026-11-13',
    });
  });

  it('sends local midnight to the local midnight after the last day', () => {
    expect(rangeInstants({ from: '2026-11-13', to: '2026-11-13' })).toEqual({
      from: new Date(2026, 10, 13).toISOString(),
      to: new Date(2026, 10, 14).toISOString(),
    });
  });

  it('plots daily buckets only for ranges over a week', () => {
    expect(chartRangeFor({ from: '2026-11-07', to: '2026-11-13' })).toBe('7d');
    expect(chartRangeFor({ from: '2026-11-06', to: '2026-11-13' })).toBe('30d');
  });
});
