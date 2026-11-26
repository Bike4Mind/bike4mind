import { obligationRepository, userRepository, type IObligation } from '@bike4mind/database';
import { BRIEF_OBLIGATION_LIMIT, type BriefObligation } from './briefCompose.composition';

/** How many days ahead of its due date a confirmed obligation starts appearing in the brief. */
export const OBLIGATION_LEAD_DAYS = 7;

/** The calendar day of `at` in `timeZone`, as `YYYY-MM-DD`; an unknown zone reads as UTC. */
export function calendarDayIn(at: Date, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Confirmed obligations due from today through the lead window, in the user's brief time zone. Not settled
 * once briefed: each one repeats in every brief until its due date passes. Overdue ones are left out.
 */
export async function loadDueBriefObligations(userId: string, now: Date) {
  const { schedule } = await userRepository.getBriefSchedule(userId);
  const today = calendarDayIn(now, schedule?.timeZone);
  return obligationRepository.listDueForBrief(
    userId,
    today,
    addDays(today, OBLIGATION_LEAD_DAYS),
    BRIEF_OBLIGATION_LIMIT
  );
}

export function toBriefObligation(item: IObligation, now: Date): BriefObligation {
  return {
    obligationId: item._id.toString(),
    payee: item.payee,
    amount: item.amountValue,
    currency: item.currency,
    dueDate: (item.dueDate ?? now).toISOString().slice(0, 10),
    summary: item.summary,
  };
}
