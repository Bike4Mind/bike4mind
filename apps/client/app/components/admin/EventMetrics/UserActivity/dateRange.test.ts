import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { getActivePreset, getPresetRange, isCompleteDateRange } from './dateRange';

const daysAgo = (days: number) => dayjs().subtract(days, 'day').format('YYYY-MM-DD');
const spanDays = ({ startDate, endDate }: { startDate: string; endDate: string }) =>
  dayjs(endDate).diff(dayjs(startDate), 'day') + 1;

describe('getPresetRange', () => {
  it('covers exactly 7 days ending today for "Last 7 Days"', () => {
    const range = getPresetRange(7);

    expect(range).toEqual({ startDate: daysAgo(6), endDate: daysAgo(0) });
    expect(spanDays(range)).toBe(7);
  });

  it('covers exactly 30 days ending today for "Last 30 Days"', () => {
    expect(spanDays(getPresetRange(30))).toBe(30);
  });

  it('covers only today for "Today"', () => {
    expect(getPresetRange(1)).toEqual({ startDate: daysAgo(0), endDate: daysAgo(0) });
  });
});

describe('getActivePreset', () => {
  it('recognises the range each preset produces', () => {
    expect(getActivePreset(getPresetRange(1))).toBe(1);
    expect(getActivePreset(getPresetRange(7))).toBe(7);
    expect(getActivePreset(getPresetRange(30))).toBe(30);
  });

  it('treats an 8-day range as custom', () => {
    expect(getActivePreset({ startDate: daysAgo(7), endDate: daysAgo(0) })).toBeNull();
  });

  it('treats a 7-day range that does not end today as custom', () => {
    expect(getActivePreset({ startDate: daysAgo(7), endDate: daysAgo(1) })).toBeNull();
  });
});

describe('isCompleteDateRange', () => {
  it('accepts a range with both dates complete', () => {
    expect(isCompleteDateRange({ startDate: '2026-01-01', endDate: '2026-01-07' })).toBe(true);
  });

  it('rejects an empty or partial bound', () => {
    expect(isCompleteDateRange({ startDate: '', endDate: '2026-01-07' })).toBe(false);
    expect(isCompleteDateRange({ startDate: '2026-01-01', endDate: '' })).toBe(false);
    expect(isCompleteDateRange({ startDate: '202-01-01', endDate: '2026-01-07' })).toBe(false);
  });
});
