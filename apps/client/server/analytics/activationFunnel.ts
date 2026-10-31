import { CreditHolderType, CreditPurchaseStatus, UnprocessableEntityError } from '@bike4mind/common';
import {
  AnalyticsUserDay,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
  Organization,
  User,
} from '@bike4mind/database';
import {
  resolveSubscriptionSource,
  SubscriptionOwnerType,
  SubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import type { UserFunnelStep } from '@client/app/utils/adminUsersFilter';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { currentStaffRegex, isCountedUser, type UserFlags } from './signupCohort';

/**
 * The activation funnel of docs/admin-analytics-spec.md 4.5. The users list's funnelStep filter resolves
 * here, and funnelStepOf is the one step rule for anything else that counts the funnel.
 */

const DAY_MS = 86_400_000;
const USER_BATCH = 1000;

/** UTC days after the signup day in which AI activity counts toward first action and coming back. */
export const ACTIVATION_WINDOW_DAYS = 7;
/** UTC days after the signup day in which a purchase counts as converting to paid. */
export const PAID_CONVERSION_WINDOW_DAYS = 30;
/** Accounts younger than this are too new to judge and left out of every step. */
export const ACTIVATION_MIN_AGE_MS = ACTIVATION_WINDOW_DAYS * DAY_MS;
/** Most signups one funnel filter resolves; a larger window is refused rather than truncated. */
export const FUNNEL_COHORT_MAX = 20_000;
/** Stripe statuses under which no payment has been collected yet. */
const UNPAID_SUBSCRIPTION_STATUSES = ['incomplete', 'incomplete_expired', 'trialing'];

const utcDayOf = (date: Date) => date.toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
/** Whole UTC days from the signup day to `day`; 0 is the signup day itself. */
const daysAfterSignup = (signupAt: Date, day: string) => (dayStart(day) - dayStart(utcDayOf(signupAt))) / DAY_MS;

/** Whether a payment converts the signup: on the signup's UTC day or up to PAID_CONVERSION_WINDOW_DAYS after. */
export function paidInConversionWindow(signupAt: Date, paidAt: Date): boolean {
  const days = daysAfterSignup(signupAt, utcDayOf(paidAt));
  return days >= 0 && days <= PAID_CONVERSION_WINDOW_DAYS;
}

/**
 * The furthest step a user reached. Each step needs the ones before it, so counts only shrink down the
 * funnel. `activeDays` are the UTC days (YYYY-MM-DD) with AI activity; `paid` is a converting payment.
 */
export function funnelStepOf({
  signupAt,
  activeDays,
  paid,
}: {
  signupAt: Date;
  activeDays: Iterable<string>;
  paid: boolean;
}): UserFunnelStep {
  let firstAction = false;
  let cameBack = false;
  for (const day of activeDays) {
    const days = daysAfterSignup(signupAt, day);
    if (days < 0 || days > ACTIVATION_WINDOW_DAYS) continue;
    firstAction = true;
    if (days >= 1) cameBack = true;
  }
  if (!firstAction) return 'signedUp';
  if (!cameBack) return 'firstAction';
  return paid ? 'paid' : 'cameBack';
}

type CohortMember = { id: string; signupAt: Date };

const pushTo = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
};

async function loadActiveDays(batch: CohortMember[], deadlineMs: number): Promise<Map<string, string[]>> {
  const signupDays = batch.map(member => utcDayOf(member.signupAt)).sort();
  const lastDay = utcDayOf(new Date(dayStart(signupDays[signupDays.length - 1]) + ACTIVATION_WINDOW_DAYS * DAY_MS));
  const rows = await AnalyticsUserDay.find(
    { userId: { $in: batch.map(member => member.id) }, day: { $gte: signupDays[0], $lte: lastDay } },
    { _id: 0, userId: 1, day: 1 }
  )
    .hint({ userId: 1, day: 1 })
    .maxTimeMS(deadlineMs)
    .lean<{ userId: string; day: string }[]>();
  const days = new Map<string, string[]>();
  for (const row of rows) pushTo(days, row.userId, row.day);
  return days;
}

type SubscriptionRow = {
  ownerType: SubscriptionOwnerType;
  ownerId: string;
  createdAt: Date;
  source?: SubscriptionSource;
  subscriptionId?: string;
};

/**
 * When each member paid: completed credit-pack purchases, and Stripe-billed subscriptions on their own
 * account or on an organization they are the billing owner of. The same rows Revenue counts; admin
 * grants are comps, not payments.
 */
async function loadPaymentTimes(batch: CohortMember[], deadlineMs: number): Promise<Map<string, Date[]>> {
  const ids = batch.map(member => member.id);
  const since = new Date(Math.min(...batch.map(member => member.signupAt.getTime())));
  const until = new Date(
    dayStart(utcDayOf(new Date(Math.max(...batch.map(member => member.signupAt.getTime()))))) +
      (PAID_CONVERSION_WINDOW_DAYS + 1) * DAY_MS
  );
  const [purchases, ownedOrganizations] = await Promise.all([
    CreditTransaction.find({
      $and: [
        // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
        { ownerId: { $in: ids }, ownerType: CreditHolderType.User, type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
        { type: 'purchase', status: CreditPurchaseStatus.Completed, createdAt: { $gte: since, $lt: until } },
      ],
    })
      .select('ownerId createdAt')
      .maxTimeMS(deadlineMs)
      .lean<{ ownerId: string; createdAt: Date }[]>(),
    Organization.find({ userId: { $in: ids } })
      .select('_id userId')
      .maxTimeMS(deadlineMs)
      .lean<{ _id: unknown; userId: string }[]>(),
  ]);
  const ownerOfOrganization = new Map(ownedOrganizations.map(org => [String(org._id), org.userId]));
  const subscriptions: SubscriptionRow[] = await Subscription.find({
    $or: [
      { ownerType: SubscriptionOwnerType.User, ownerId: { $in: ids } },
      ...(ownerOfOrganization.size > 0
        ? [{ ownerType: SubscriptionOwnerType.Organization, ownerId: { $in: [...ownerOfOrganization.keys()] } }]
        : []),
    ],
    status: { $nin: UNPAID_SUBSCRIPTION_STATUSES },
    createdAt: { $gte: since, $lt: until },
  })
    .select('ownerType ownerId createdAt source subscriptionId')
    .maxTimeMS(deadlineMs)
    .lean<SubscriptionRow[]>();

  const paidAt = new Map<string, Date[]>();
  for (const purchase of purchases) pushTo(paidAt, purchase.ownerId, new Date(purchase.createdAt));
  for (const subscription of subscriptions) {
    if (resolveSubscriptionSource(subscription) !== SubscriptionSource.Stripe) continue;
    const userId =
      subscription.ownerType === SubscriptionOwnerType.User
        ? subscription.ownerId
        : ownerOfOrganization.get(subscription.ownerId);
    if (userId) pushTo(paidAt, userId, new Date(subscription.createdAt));
  }
  return paidAt;
}

/**
 * Ids of the counted users created in [start, end), old enough to judge at `now`, whose furthest funnel
 * step is `step`. A window holding more than FUNNEL_COHORT_MAX signups is refused.
 */
export async function funnelStepUserIds(
  { start, end, step }: { start: Date; end: Date; step: UserFunnelStep },
  { now, deadlineMs }: { now: Date; deadlineMs: number }
): Promise<string[]> {
  const judgeableUntil = new Date(now.getTime() - ACTIVATION_MIN_AGE_MS);
  const users = await User.find({ createdAt: { $gte: start, $lt: end, $lte: judgeableUntil } })
    .select('_id email createdAt isAdmin isSystem isSynthetic')
    .hint({ createdAt: 1 })
    .limit(FUNNEL_COHORT_MAX + 1)
    .maxTimeMS(deadlineMs)
    .lean<(UserFlags & { createdAt: Date })[]>();
  if (users.length > FUNNEL_COHORT_MAX) {
    throw new UnprocessableEntityError(
      `More than ${FUNNEL_COHORT_MAX.toLocaleString('en-US')} signups in this window. Narrow the created range.`
    );
  }
  const staffRegex = currentStaffRegex();
  const cohort: CohortMember[] = users
    .filter(user => isCountedUser(user, staffRegex))
    .map(user => ({ id: String(user._id), signupAt: new Date(user.createdAt) }));
  // A strict funnel: payment only separates came back from paid.
  const needsPayments = step === 'cameBack' || step === 'paid';
  const matched: string[] = [];
  for (let i = 0; i < cohort.length; i += USER_BATCH) {
    const batch = cohort.slice(i, i + USER_BATCH);
    const [activeDays, paidAt] = await Promise.all([
      loadActiveDays(batch, deadlineMs),
      needsPayments ? loadPaymentTimes(batch, deadlineMs) : new Map<string, Date[]>(),
    ]);
    for (const member of batch) {
      const paid = (paidAt.get(member.id) ?? []).some(at => paidInConversionWindow(member.signupAt, at));
      if (funnelStepOf({ signupAt: member.signupAt, activeDays: activeDays.get(member.id) ?? [], paid }) === step) {
        matched.push(member.id);
      }
    }
  }
  return matched;
}
