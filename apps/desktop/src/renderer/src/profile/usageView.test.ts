import type { UsageBar } from '@shared/usage';
import { describe, expect, it } from 'vitest';
import { barPercent, bucketLabel, formatCredits, runwayDays, tickIndices } from './usageView';

function hours(count: number, from = '2026-10-07T00:00:00.000Z'): UsageBar[] {
  const start = Date.parse(from);
  return Array.from({ length: count }, (_, index) => ({
    startsAt: new Date(start + index * 3_600_000).toISOString(),
    creditsSpent: 0,
    requests: 0,
  }));
}

function days(count: number): UsageBar[] {
  const start = Date.parse('2026-09-07T00:00:00.000Z');
  return Array.from({ length: count }, (_, index) => ({
    startsAt: new Date(start + index * 86_400_000).toISOString(),
    creditsSpent: 0,
    requests: 0,
  }));
}

describe('bucketLabel', () => {
  // The day buckets ARE UTC days, so formatting them locally would slide every label.
  it('names a day bucket by its UTC date', () => {
    expect(bucketLabel('2026-10-07T00:00:00.000Z', 'day')).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
        new Date('2026-10-07T00:00:00.000Z')
      )
    );
  });

  it('names an hour bucket by the local clock, zero padded', () => {
    const at = '2026-10-07T05:00:00.000Z';
    expect(bucketLabel(at, 'hour')).toBe(String(new Date(at).getHours()).padStart(2, '0'));
  });
});

describe('tickIndices', () => {
  it('puts the hour ticks on the quarter-day marks', () => {
    const bars = hours(24);
    const labelled = tickIndices(bars, 'hour').map(index => Number(bucketLabel(bars[index].startsAt, 'hour')));
    expect(labelled).toHaveLength(4);
    expect(labelled.every(hour => hour % 6 === 0)).toBe(true);
  });

  // Today is the label a reader looks for first, so it is the one the spacing is anchored to.
  it('always labels the newest day', () => {
    expect(tickIndices(days(31), 'day')).toContain(30);
  });

  // A day bar is narrower than the date it is labelled with, so the labels have to be thinned.
  it('thins the day labels however long the window is', () => {
    expect(tickIndices(days(31), 'day').length).toBeLessThanOrEqual(7);
    expect(tickIndices(days(5), 'day')).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('formatCredits', () => {
  it('keeps a small spend visible rather than rounding it to nothing', () => {
    expect(formatCredits(0.42)).toBe('0.42');
    expect(formatCredits(0)).toBe('0');
  });

  it('groups a large figure and drops the decimals', () => {
    expect(formatCredits(31_666.7)).toBe((31_667).toLocaleString());
  });
});

describe('barPercent', () => {
  it('scales against the tallest bar and leaves an empty bucket at nothing', () => {
    expect(barPercent(5, 10)).toBe(50);
    expect(barPercent(0, 10)).toBe(0);
    expect(barPercent(5, 0)).toBe(0);
  });
});

describe('runwayDays', () => {
  it('divides the balance by the window rate', () => {
    expect(runwayDays(1000, 300, 30)).toBe(100);
  });

  // "Runs out in forever" is not a warning, and this figure exists to be one.
  it('has no answer for a window that spent nothing, or a balance it could not read', () => {
    expect(runwayDays(1000, 0, 30)).toBeNull();
    expect(runwayDays(null, 300, 30)).toBeNull();
    expect(runwayDays(0, 300, 30)).toBeNull();
  });
});
