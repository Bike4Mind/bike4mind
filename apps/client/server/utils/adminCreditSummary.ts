import type { AdminCreditSummary } from '@bike4mind/common';
import { AI_SPEND_DAILY_WINDOW_DAYS } from '@bike4mind/database';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One entry per UTC day, oldest first, ending on the day of `now`; days without spend are zero. */
export function zeroFilledDailySpend(
  sparse: Array<{ day: string; credits: number }>,
  now: Date
): AdminCreditSummary['daily'] {
  const byDay = new Map(sparse.map(({ day, credits }) => [day, credits]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: AI_SPEND_DAILY_WINDOW_DAYS }, (_, index) => {
    const date = new Date(today - (AI_SPEND_DAILY_WINDOW_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10);
    return { date, credits: byDay.get(date) ?? 0 };
  });
}
