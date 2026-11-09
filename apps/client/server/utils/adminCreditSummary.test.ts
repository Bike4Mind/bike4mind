import { describe, expect, it, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({ AI_SPEND_DAILY_WINDOW_DAYS: 90 }));

import { chargedSpend } from './adminCreditSummary';

const now = new Date('2026-11-06T12:00:00Z');

describe('chargedSpend', () => {
  it('ranks the top model by charged credits after write-offs', () => {
    const spend = chargedSpend(
      {
        spent: { last24h: 150, last7d: 150, last30d: 150 },
        topModel30d: { model: 'A', credits: 100 },
        dailyCredits: [],
        byModel: [
          { key: 'A', last7d: 100, last30d: 100, last90d: 100 },
          { key: 'B', last7d: 50, last30d: 50, last90d: 50 },
        ],
        bySource: [],
      },
      [{ createdAt: new Date('2026-11-06T10:00:00Z'), writtenOffCredits: 90, model: 'A' }],
      now
    );

    expect(spend.topModel30d).toEqual({ model: 'B', credits: 50 });
    expect(spend.byModel.map(bucket => [bucket.key, bucket.last30d])).toEqual([
      ['B', 50],
      ['A', 10],
    ]);
  });

  it('counts charged credits and reports the written-off shortfall on its own', () => {
    // The capped turn: 1,998 balance, 2,016 cost, 18 written off; plus a 2-credit turn earlier.
    const spend = chargedSpend(
      {
        spent: { last24h: 2016, last7d: 2018, last30d: 2018 },
        topModel30d: { model: 'opus', credits: 2018 },
        dailyCredits: [
          { day: '2026-11-04', credits: 2 },
          { day: '2026-11-06', credits: 2016 },
        ],
        byModel: [{ key: 'opus', last7d: 2018, last30d: 2018, last90d: 2018 }],
        bySource: [
          { key: 'web', last7d: 2018, last30d: 2018, last90d: 2018 },
          { key: null, last7d: 5, last30d: 5, last90d: 5 },
        ],
      },
      [{ createdAt: new Date('2026-11-06T10:00:00Z'), writtenOffCredits: 18, model: 'opus', source: 'web' }],
      now
    );

    expect(spend.spent).toEqual({ last24h: 1998, last7d: 2000, last30d: 2000 });
    expect(spend.writtenOff).toEqual({ last24h: 18, last7d: 18, last30d: 18 });
    expect(spend.topModel30d).toEqual({ model: 'opus', credits: 2000 });
    expect(spend.dailyCredits).toEqual([
      { day: '2026-11-04', credits: 2 },
      { day: '2026-11-06', credits: 1998 },
    ]);
    expect(spend.byModel).toEqual([{ key: 'opus', last7d: 2000, last30d: 2000, last90d: 2000 }]);
    expect(spend.bySource).toEqual([
      { key: 'web', last7d: 2000, last30d: 2000, last90d: 2000 },
      { key: null, last7d: 5, last30d: 5, last90d: 5 },
    ]);
  });

  it('leaves a write-off outside a window out of that window', () => {
    const spend = chargedSpend(
      {
        spent: { last24h: 0, last7d: 0, last30d: 100 },
        topModel30d: null,
        dailyCredits: [],
        byModel: [],
        bySource: [],
      },
      [{ createdAt: new Date('2026-10-20T10:00:00Z'), writtenOffCredits: 10 }],
      now
    );
    expect(spend.spent).toEqual({ last24h: 0, last7d: 0, last30d: 90 });
    expect(spend.writtenOff).toEqual({ last24h: 0, last7d: 0, last30d: 10 });
  });
});
