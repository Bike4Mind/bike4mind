import type { UserCreditHistory } from '@bike4mind/common';

export type CreditSpend = {
  /** Credits used over the window. */
  total: number;
  /** Credits used per day, oldest first, one entry per day in the window. */
  daily: number[];
  /** True when part of the window is before the point the balance history can be trusted. */
  estimated: boolean;
};

/**
 * Spend reconstructed from the daily balance series: every day-over-day drop counts as usage, except
 * the part an admin deduction explains. Grants and renewals raise the balance and so never count.
 */
export const creditSpendFromHistory = (history: UserCreditHistory, windowDays = 30): CreditSpend => {
  const points = history.points.slice(-(windowDays + 1));
  const adminDeductionsByDay = new Map<string, number>();
  for (const adjustment of history.adjustments) {
    if (adjustment.credits >= 0) continue;
    const day = adjustment.occurredAt.slice(0, 10);
    adminDeductionsByDay.set(day, (adminDeductionsByDay.get(day) ?? 0) - adjustment.credits);
  }

  const daily = points.slice(1).map((point, index) => {
    const drop = points[index].balance - point.balance;
    return Math.max(drop - (adminDeductionsByDay.get(point.day.slice(0, 10)) ?? 0), 0);
  });

  const windowStart = points[0]?.day;
  return {
    total: daily.reduce((sum, value) => sum + value, 0),
    daily,
    estimated: !!history.unreliableBefore && !!windowStart && history.unreliableBefore > windowStart,
  };
};
