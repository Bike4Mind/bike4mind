/**
 * Zero-fill every day in the window so a trend chart draws gaps as flat rather
 * than connecting non-adjacent active days into a misleading straight line.
 * Days are UTC to match the aggregations' $dateToString bucketing.
 *
 * Returns days + 1 points spanning today-days .. today (UTC). The aggregations'
 * window start is a rolling `now - days*24h`, whose calendar day is `today - days`;
 * include that leading day or its (partial) volume drops off the chart while
 * still counting in the totals, leaving the chart unable to reconcile.
 */
export const zeroFillDailySeries = <T extends { day: string }>(
  points: readonly T[],
  days: number,
  valueOf: (point: T) => number
): { day: string; value: number }[] => {
  const byDay = new Map(points.map(p => [p.day, valueOf(p)]));
  const today = new Date();
  return Array.from({ length: days + 1 }, (_, i) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - i));
    const day = d.toISOString().slice(0, 10);
    return { day, value: byDay.get(day) ?? 0 };
  });
};
