import dayjs from 'dayjs';

// Below this many days of history, a balance / burn-rate projection swings by orders of magnitude
// on a single busy day, so "Days remaining" is withheld rather than shown.
export const MIN_DAYS_FOR_PROJECTION = 7;

interface Usage {
  credits: number;
  createdAt: Date | string;
}

export interface BurnStats {
  burnRate: number;
  usageTrend: 'increasing' | 'decreasing' | 'stable';
  /** Null when there is no burn, no balance, or under MIN_DAYS_FOR_PROJECTION days of history. */
  daysRemaining: number | null;
  /** Days the rate is averaged over: the selected period, cut to the account's age. */
  observedDays: number;
}

/**
 * Average daily burn over the selected period, but never over days before the account existed: a
 * day-old account averaging one day's spend across 30 days reported thousands of days remaining.
 */
export function computeBurnStats({
  usage,
  periodDays,
  now = new Date(),
  accountCreatedAt,
  balance,
}: {
  usage: Usage[];
  periodDays: number;
  now?: Date;
  accountCreatedAt?: Date | string;
  balance?: number;
}): BurnStats {
  const end = dayjs(now);
  const periodStart = end.subtract(periodDays, 'day');
  const created = accountCreatedAt ? dayjs(accountCreatedAt) : undefined;
  const start = created?.isValid() && created.isAfter(periodStart) ? created : periodStart;
  // Fractional days, floored at one, so a few hours of history is averaged as one day.
  const observedDays = Math.max(1, end.diff(start, 'day', true));

  const stats: BurnStats = { burnRate: 0, usageTrend: 'stable', daysRemaining: null, observedDays };
  if (usage.length === 0) return stats;

  const totalUsage = usage.reduce((sum, t) => sum + Math.abs(t.credits), 0);
  stats.burnRate = totalUsage / observedDays;

  // Compare the first half of the observed window to the second, with a 10% threshold.
  if (observedDays >= 6) {
    const midPoint = start.add(end.diff(start) / 2, 'millisecond');
    const firstHalfUsage = usage
      .filter(t => dayjs(t.createdAt).isBefore(midPoint))
      .reduce((sum, t) => sum + Math.abs(t.credits), 0);
    const secondHalfUsage = totalUsage - firstHalfUsage;
    const halfDays = observedDays / 2;
    const changePercent =
      ((secondHalfUsage / halfDays - firstHalfUsage / halfDays) / (firstHalfUsage / halfDays)) * 100;
    if (changePercent > 10) stats.usageTrend = 'increasing';
    else if (changePercent < -10) stats.usageTrend = 'decreasing';
  }

  if (stats.burnRate > 0 && balance !== undefined && balance > 0 && observedDays >= MIN_DAYS_FOR_PROJECTION) {
    stats.daysRemaining = Math.floor(balance / stats.burnRate);
  }
  return stats;
}
