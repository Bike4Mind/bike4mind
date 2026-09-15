import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spendPeriodLabels } from './spendPeriodLabels';

// The bug this suite guards - rendering an ISO instant as its UTC calendar day rather
// than the viewer's - is only observable east of UTC, and GitHub runners default to UTC
// (nothing in .github/workflows or the vitest config sets TZ). Pin an eastern, DST-free
// zone so the suite actually fails on a revert. Every expectation below is a hand-computed
// local day for a literal UTC instant, never a round trip through the helper's own
// formatting, so an unpinned run fails loudly instead of silently agreeing with itself.
const PINNED_TZ = 'Asia/Shanghai'; // UTC+8 year-round
const originalTz = process.env.TZ;

describe('spendPeriodLabels', () => {
  beforeAll(() => {
    process.env.TZ = PINNED_TZ;
  });

  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('labels the default trailing window when no range is set', () => {
    expect(spendPeriodLabels()).toEqual({ periodLabel: 'Last 30 days', priorPeriodLabel: 'Prior 30 days' });
    expect(spendPeriodLabels(undefined, undefined)).toEqual({
      periodLabel: 'Last 30 days',
      priorPeriodLabel: 'Prior 30 days',
    });
  });

  it('renders the range in local time so the label matches the ControlPanel chips', () => {
    // Local midnight on 2026-01-01 and 2026-01-08 in UTC+8 - the instants the
    // ControlPanel sends. Their UTC calendar days are a day earlier, so formatting
    // via toISOString().slice(0, 10) (the bug) prints '2025-12-31 - 2026-01-07'.
    const { periodLabel } = spendPeriodLabels('2025-12-31T16:00:00.000Z', '2026-01-07T16:00:00.000Z');
    expect(periodLabel).toBe('2026-01-01 - 2026-01-08');
  });

  it('derives an equal-length prior window immediately before the range', () => {
    // Local 2026-01-08 through 2026-01-15 in UTC+8: a 7-day window whose prior
    // window is local 2026-01-01 through 2026-01-08.
    const { priorPeriodLabel } = spendPeriodLabels('2026-01-07T16:00:00.000Z', '2026-01-14T16:00:00.000Z');
    expect(priorPeriodLabel).toBe('2026-01-01 - 2026-01-08');
  });
});
