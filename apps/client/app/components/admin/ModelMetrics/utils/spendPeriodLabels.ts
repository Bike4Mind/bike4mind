import dayjs from 'dayjs';
import { SPEND_DEFAULT_WINDOW_DAYS } from '@bike4mind/common';

export interface SpendPeriodLabels {
  periodLabel: string;
  priorPeriodLabel: string;
}

/**
 * Format the current and prior spend-window labels in the VIEWER's local timezone so
 * they match the ControlPanel range chips. The server can't produce these: it holds
 * only UTC instants and never receives the caller's timezone, so a local-midnight
 * range rendered with toISOString() lands a calendar day early east of UTC.
 *
 * Mirrors the window math in the /api/admin/spend handler's resolveWindows: with no
 * range it is the default trailing window; otherwise the prior window is the same
 * length immediately before `from`. dateFrom/dateTo are ISO instants from the filter.
 */
export function spendPeriodLabels(dateFrom?: string, dateTo?: string): SpendPeriodLabels {
  const hasFrom = Boolean(dateFrom);
  const hasTo = Boolean(dateTo);
  if (!hasFrom && !hasTo) {
    return {
      periodLabel: `Last ${SPEND_DEFAULT_WINDOW_DAYS} days`,
      priorPeriodLabel: `Prior ${SPEND_DEFAULT_WINDOW_DAYS} days`,
    };
  }

  const to = hasTo ? dayjs(dateTo) : dayjs();
  const from = hasFrom ? dayjs(dateFrom) : to.subtract(SPEND_DEFAULT_WINDOW_DAYS, 'day');
  const windowMs = Math.max(to.valueOf() - from.valueOf(), 0);
  const priorTo = from;
  const priorFrom = from.subtract(windowMs, 'millisecond');
  const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');

  return {
    periodLabel: `${fmt(from)} - ${fmt(to)}`,
    priorPeriodLabel: `${fmt(priorFrom)} - ${fmt(priorTo)}`,
  };
}
