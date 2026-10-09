import { describe, it, expect, vi, afterEach } from 'vitest';
import { zeroFillDailySeries } from './dailySeries';

describe('zeroFillDailySeries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('spans days + 1 UTC days ending today, zero-filling the gaps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T23:30:00Z'));

    const series = zeroFillDailySeries(
      [
        { day: '2026-03-07', n: 4 },
        { day: '2026-03-10', n: 9 },
      ],
      3,
      p => p.n
    );

    expect(series).toEqual([
      { day: '2026-03-07', value: 4 },
      { day: '2026-03-08', value: 0 },
      { day: '2026-03-09', value: 0 },
      { day: '2026-03-10', value: 9 },
    ]);
  });
});
