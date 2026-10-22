import { describe, expect, it } from 'vitest';
import { dailyBars, featureRows, hourlyBars, humanize, modelRows, sourceRows, sumBars } from './usageBuckets';

const NOON = new Date('2026-10-07T12:34:56.000Z');

describe('hourlyBars', () => {
  it('covers every hour of the window, including the ones that spent nothing', () => {
    const bars = hourlyBars([], NOON);
    expect(bars).toHaveLength(24);
    expect(bars.every(bar => bar.creditsSpent === 0 && bar.requests === 0)).toBe(true);
  });

  // The ledger stores usage as a negative credit; a chart of negative bars would be upside down.
  it('charts the magnitude of a deduction, not its sign', () => {
    const at = new Date(NOON.getTime() - 60_000).toISOString();
    const bars = hourlyBars([{ createdAt: at, credits: -42 }], NOON);
    expect(bars[23]).toMatchObject({ creditsSpent: 42, requests: 1 });
  });

  it('adds up every row that falls in one hour', () => {
    const rows = [
      { createdAt: new Date(NOON.getTime() - 60_000).toISOString(), credits: -3 },
      { createdAt: new Date(NOON.getTime() - 120_000).toISOString(), credits: -7 },
    ];
    expect(sumBars(hourlyBars(rows, NOON))).toEqual({ creditsSpent: 10, requests: 2 });
  });

  it('drops rows outside the window rather than folding them into an edge bucket', () => {
    const old = new Date(NOON.getTime() - 48 * 3_600_000).toISOString();
    const ahead = new Date(NOON.getTime() + 3_600_000).toISOString();
    const bars = hourlyBars(
      [
        { createdAt: old, credits: -5 },
        { createdAt: ahead, credits: -5 },
      ],
      NOON
    );
    expect(sumBars(bars)).toEqual({ creditsSpent: 0, requests: 0 });
  });

  it('ignores a row the server shaped unexpectedly instead of charting a NaN', () => {
    const at = new Date(NOON.getTime() - 60_000).toISOString();
    const bars = hourlyBars(
      [
        { createdAt: at, credits: '-5' },
        { createdAt: null, credits: -5 },
      ],
      NOON
    );
    expect(sumBars(bars)).toEqual({ creditsSpent: 0, requests: 0 });
  });
});

describe('dailyBars', () => {
  // The server's window starts at this clock time `days` ago, so its first bucket is a partial
  // UTC day. Spanning it is what keeps the totals above the chart equal to what the chart draws.
  it('spans every UTC day the server window touches', () => {
    const bars = dailyBars([], NOON, 30);
    expect(bars).toHaveLength(31);
    expect(bars[0].startsAt).toBe('2026-09-07T00:00:00.000Z');
    expect(bars[30].startsAt).toBe('2026-10-07T00:00:00.000Z');
  });

  it('fills the days the server reported nothing for with zero', () => {
    const bars = dailyBars([{ day: '2026-10-06', creditsCharged: 120, requests: 4 }], NOON, 30);
    expect(bars[29]).toMatchObject({ creditsSpent: 120, requests: 4 });
    expect(bars[28].creditsSpent).toBe(0);
  });

  it('keeps a day the server reported as zero spend, which is a real answer', () => {
    const bars = dailyBars([{ day: '2026-10-07', creditsCharged: 0, requests: 0 }], NOON, 1);
    expect(bars.at(-1)).toMatchObject({ creditsSpent: 0, requests: 0 });
  });
});

describe('breakdown rows', () => {
  it('labels a model by its id and keeps the provider as the secondary line', () => {
    const rows = modelRows([{ provider: 'anthropic', model: 'claude-opus-5', creditsCharged: 9, requests: 2 }]);
    expect(rows).toEqual([
      { key: 'anthropic:claude-opus-5', label: 'claude-opus-5', detail: 'anthropic', creditsSpent: 9, requests: 2 },
    ]);
  });

  it('turns the wire slugs into something readable', () => {
    expect(humanize('agent_execution')).toBe('Agent execution');
    expect(featureRows([{ feature: 'agent_execution', creditsCharged: 4, requests: 1 }])[0].label).toBe(
      'Agent execution'
    );
  });

  // The by-source cut comes off the ledger, which names its spend differently from the rest.
  it('reads the by-source cut from creditsSpent', () => {
    expect(sourceRows([{ source: 'desktop', creditsSpent: 11, requests: 3 }])[0]).toMatchObject({
      label: 'Desktop',
      creditsSpent: 11,
    });
  });

  it('does not drop a row the server left a field off', () => {
    expect(modelRows([{ creditsCharged: 5 }])[0]).toMatchObject({ label: 'Unknown model', requests: 0 });
  });
});
