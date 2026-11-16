import {
  ACQUISITION_UNATTRIBUTED_KEY,
  attributedTouch,
  type AcquisitionTouchKind,
  type AttributedTouch,
  type StoredAcquisition,
} from '../app/utils/acquisitionTouch';
import { COHORT_MAX_TIME_MS, findEligibleSignups, withinBudget } from './activationFunnel';
import {
  classifyFirstPaid,
  loadPaymentLedger,
  paidWithinDays,
  utcDayStart,
  type LedgerPayment,
  type LedgerPaymentKind,
  type PaymentLedger,
} from './paymentLedger';
import { loadCountingContext } from './signupCohort';

/**
 * Signup cohorts grouped by the campaign touch stored on the user at signup (user.acquisition, written by
 * recordSignupAcquisition in apps/client/server/analytics/funnel.ts). The admin Analytics acquisition section
 * and its Users drill-down both resolve through attributedSignups, so their counts agree.
 */

/** ms. One acquisition request, summary or Users drill-down, kept well inside the 60s API Lambda. */
export const ACQUISITION_BUDGET_MS = 40_000;

export type AttributedSignup = { id: string; signupAt: Date; touch: AttributedTouch | null };

/**
 * Every active-eligible signup created in [start, end), with its cohort touch. Accounts marked isInternal
 * are left out too. Unlike the activation funnel there is no minimum age: maturity is judged per metric.
 * More than FUNNEL_COHORT_MAX signups is refused with a 422.
 */
export async function attributedSignups(
  { start, end }: { start: Date; end: Date },
  { touch, maxTimeMS }: { touch: AcquisitionTouchKind; maxTimeMS: () => number }
): Promise<AttributedSignup[]> {
  const ctx = await loadCountingContext();
  const users = await findEligibleSignups<{ isInternal?: boolean; acquisition?: StoredAcquisition }>(
    { $gte: start, $lt: end },
    { ctx, maxTimeMS: maxTimeMS(), extraFields: 'isInternal acquisition.firstTouch acquisition.lastTouch' }
  );
  return users
    .filter(user => !user.isInternal)
    .map(user => ({
      id: String(user._id),
      signupAt: new Date(user.createdAt),
      touch: attributedTouch(user.acquisition, touch),
    }));
}

const DAY_MS = 86_400_000;
const LEDGER_BATCH = 1000;

export type ConversionOptions = { windowDays: number; followUpDays: number; now: Date };

/** Whether the whole conversion window (the signup's UTC day plus `windowDays` more) has passed by `now`. */
export function conversionWindowClosed(signupAt: Date, windowDays: number, now: Date): boolean {
  return utcDayStart(signupAt) + (windowDays + 1) * DAY_MS <= now.getTime();
}

/** `at` moved forward by a Stripe billing interval, clamping to the target month's last day; null if unknown. */
export function addBillingInterval(at: Date, interval: string, count: number): Date | null {
  if (!Number.isInteger(count) || count < 1) return null;
  if (interval === 'day' || interval === 'week') {
    return new Date(at.getTime() + count * (interval === 'week' ? 7 : 1) * DAY_MS);
  }
  if (interval !== 'month' && interval !== 'year') return null;
  const months = at.getUTCMonth() + count * (interval === 'year' ? 12 : 1);
  const year = at.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const next = new Date(at);
  next.setUTCFullYear(year, month, Math.min(at.getUTCDate(), lastDay));
  return next;
}

/**
 * There is no invoice ledger, so a renewal is derived from the subscription's current state: its period
 * started on or after the first renewal date (trial end or creation plus one billing interval), and that
 * date fell inside the follow-up. `notDue` when the first renewal lies past the follow-up; `unavailable`
 * when the subscription lacks the fields to tell.
 */
export type RenewalOutcome = 'renewed' | 'notRenewed' | 'notDue' | 'unavailable';

export function deriveRenewal(subscription: LedgerPayment, followUpEnd: Date): RenewalOutcome {
  const sub = subscription.subscription;
  if (!sub?.interval || !sub.intervalCount || !sub.periodStartsAt) return 'unavailable';
  const firstRenewalAt = addBillingInterval(
    new Date(sub.trialEndsAt ?? subscription.at),
    sub.interval,
    sub.intervalCount
  );
  if (!firstRenewalAt) return 'unavailable';
  if (firstRenewalAt > followUpEnd) return 'notDue';
  return new Date(sub.periodStartsAt).getTime() >= firstRenewalAt.getTime() - DAY_MS ? 'renewed' : 'notRenewed';
}

export type MemberOutcome = {
  /** The conversion window has closed, so the member counts toward the conversion rate. */
  mature: boolean;
  firstPaid: { kind: LedgerPaymentKind; at: Date; both: boolean } | null;
  /** An organization the member owns was paid for inside the conversion window. */
  orgBuyer: boolean;
  /** Paid inside the window and at least one of those payments is still not refunded or disputed. */
  retained: boolean;
  /** null when not a buyer or the follow-up period after the first payment has not passed yet. */
  followUp: { repeatCredit: boolean; renewal: RenewalOutcome | null } | null;
};

export function memberOutcome(
  signupAt: Date,
  ledger: PaymentLedger | undefined,
  { windowDays, followUpDays, now }: ConversionOptions
): MemberOutcome {
  const firstPaid = classifyFirstPaid(ledger, signupAt, windowDays);
  const payments = ledger?.payments ?? [];
  const inWindow = payments.filter(payment => paidWithinDays(signupAt, payment.at, windowDays));
  const orgBuyerAt = ledger?.orgBuyerAt;
  let followUp: MemberOutcome['followUp'] = null;
  if (firstPaid) {
    const followUpEnd = new Date(firstPaid.at.getTime() + followUpDays * DAY_MS);
    if (followUpEnd <= now) {
      const repeatCredits = payments.filter(
        payment =>
          payment.kind === 'credit' && !payment.reversed && payment.at >= firstPaid.at && payment.at <= followUpEnd
      );
      const subscription = inWindow.find(payment => payment.kind === 'subscription');
      followUp = {
        repeatCredit: repeatCredits.length >= 2,
        renewal: subscription ? deriveRenewal(subscription, followUpEnd) : null,
      };
    }
  }
  return {
    mature: conversionWindowClosed(signupAt, windowDays, now),
    firstPaid: firstPaid && { kind: firstPaid.kind, at: firstPaid.at, both: firstPaid.both },
    orgBuyer: !!orgBuyerAt && paidWithinDays(signupAt, orgBuyerAt, windowDays),
    retained: inWindow.some(payment => !payment.reversed),
    followUp,
  };
}

/** Each member's conversion outcome, reading payment ledgers in batches. */
export async function conversionOutcomes(
  members: readonly AttributedSignup[],
  options: ConversionOptions & { maxTimeMS: () => number }
): Promise<Map<string, MemberOutcome>> {
  const outcomes = new Map<string, MemberOutcome>();
  for (let i = 0; i < members.length; i += LEDGER_BATCH) {
    const batch = members.slice(i, i + LEDGER_BATCH);
    const ledgers = await loadPaymentLedger(
      batch.map(member => member.id),
      { until: options.now, maxTimeMS: options.maxTimeMS }
    );
    for (const member of batch)
      outcomes.set(member.id, memberOutcome(member.signupAt, ledgers.get(member.id), options));
  }
  return outcomes;
}

/**
 * The ids behind one acquisition row (the Users list's acq* filter): the same attributedSignups cohort the
 * section groups, narrowed to `key` (ACQUISITION_UNATTRIBUTED_KEY for no touch), and with `converted` to the
 * mature members who paid inside `windowDays`, which is the row's `converted` count. Past `expiresAt` (epoch ms)
 * it rejects with a 504.
 */
export async function acquisitionCohortUserIds(
  window: { start: Date; end: Date },
  {
    touch,
    key,
    converted,
    windowDays,
  }: { touch: AcquisitionTouchKind; key: string; converted: boolean; windowDays: number },
  { now, expiresAt }: { now: Date; expiresAt: number }
): Promise<string[]> {
  const maxTimeMS = () => Math.max(1, Math.min(COHORT_MAX_TIME_MS, expiresAt - Date.now()));
  return withinBudget(cohortUserIds(window, { touch, key, converted, windowDays }, { now, maxTimeMS }), expiresAt);
}

async function cohortUserIds(
  window: { start: Date; end: Date },
  {
    touch,
    key,
    converted,
    windowDays,
  }: { touch: AcquisitionTouchKind; key: string; converted: boolean; windowDays: number },
  { now, maxTimeMS }: { now: Date; maxTimeMS: () => number }
): Promise<string[]> {
  const cohort = await attributedSignups(window, { touch, maxTimeMS });
  const members = cohort.filter(member =>
    key === ACQUISITION_UNATTRIBUTED_KEY ? !member.touch : member.touch?.key === key
  );
  if (!converted) return members.map(member => member.id);
  // Follow-up does not decide conversion, so any period serves.
  const outcomes = await conversionOutcomes(members, { windowDays, followUpDays: windowDays, now, maxTimeMS });
  return members
    .filter(member => {
      const outcome = outcomes.get(member.id);
      return !!outcome?.mature && !!outcome.firstPaid;
    })
    .map(member => member.id);
}
