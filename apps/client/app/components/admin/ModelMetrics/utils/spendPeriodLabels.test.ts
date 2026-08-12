import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { spendPeriodLabels } from './spendPeriodLabels';

describe('spendPeriodLabels', () => {
  it('labels the default trailing window when no range is set', () => {
    expect(spendPeriodLabels()).toEqual({ periodLabel: 'Last 30 days', priorPeriodLabel: 'Prior 30 days' });
    expect(spendPeriodLabels(undefined, undefined)).toEqual({
      periodLabel: 'Last 30 days',
      priorPeriodLabel: 'Prior 30 days',
    });
  });

  it('renders the range in local time so the label matches the ControlPanel chips', () => {
    // Build the bounds as LOCAL wall-clock (no offset), then hand the helper the UTC
    // instant the ControlPanel would send (dayjs(...).toISOString()). The label must
    // render that instant back to its local calendar day - not the UTC day that
    // toISOString().slice(0,10) prints, which is a day early east of UTC (the bug).
    const from = dayjs('2026-01-01T00:00:00');
    const to = dayjs('2026-01-08T00:00:00');
    const { periodLabel } = spendPeriodLabels(from.toISOString(), to.toISOString());
    expect(periodLabel).toBe('2026-01-01 - 2026-01-08');
  });

  it('derives an equal-length prior window immediately before the range', () => {
    const from = dayjs('2026-01-08T00:00:00');
    const to = dayjs('2026-01-15T00:00:00'); // 7-day window
    const { priorPeriodLabel } = spendPeriodLabels(from.toISOString(), to.toISOString());
    expect(priorPeriodLabel).toBe('2026-01-01 - 2026-01-08');
  });
});
