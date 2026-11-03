import { SubscriptionSource } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  BILLED_INTERVALS,
  MRR_CURRENCY,
  MRR_STATUSES,
  countsTowardMrr,
  type AdminSubscriptionBilledInterval,
  type AdminSubscriptionMrr,
  type AdminSubscriptionsMrrTotal,
  type BilledInterval,
} from '@client/app/utils/adminSubscriptionsFilter';

/**
 * MRR per docs/admin-subscriptions-spec.md section 5.3: the mirrored unitAmount x quantity of Stripe-billed rows
 * in MRR_STATUSES, normalized to a month, in minor units before discounts. Never from the plan catalog's prices.
 */

type Condition = Record<string, unknown>;

// Week and day periods convert through the average month, so 52 weeks and 365 days make 12 months.
const MONTHS_PER_INTERVAL: Readonly<Record<BilledInterval, number>> = {
  month: 1,
  year: 12,
  week: 12 / 52,
  day: 12 / 365,
};

const isBilledInterval = (interval: string): interval is BilledInterval =>
  (BILLED_INTERVALS as readonly string[]).includes(interval);

/** The mirrored billing interval, with a missing count read as 1; null when the interval is missing or unknown. */
export function billedIntervalOf(
  interval: string | null | undefined,
  intervalCount: number | null | undefined
): AdminSubscriptionBilledInterval | null {
  if (!interval || !isBilledInterval(interval)) return null;
  return { interval, intervalCount: intervalCount && intervalCount > 0 ? intervalCount : 1 };
}

/** Months one billing period covers (yearly is 12, every 3 months is 3), or null for an unknown interval. */
export function monthsPerPeriod(
  interval: string | null | undefined,
  intervalCount: number | null | undefined
): number | null {
  const billed = billedIntervalOf(interval, intervalCount);
  return billed ? MONTHS_PER_INTERVAL[billed.interval] * billed.intervalCount : null;
}

export type MrrFields = {
  source?: string | null;
  status: string;
  quantity: number;
  unitAmount?: number | null;
  currency?: string | null;
  interval?: string | null;
  intervalCount?: number | null;
};

/** One row's MRR in its own billed currency; null when it does not count or has no mirrored amount. */
export function subscriptionMrr(row: MrrFields): AdminSubscriptionMrr | null {
  if (!countsTowardMrr(row) || typeof row.unitAmount !== 'number' || !row.currency) return null;
  const months = monthsPerPeriod(row.interval, row.intervalCount);
  if (months === null) return null;
  return { amount: Math.round((row.unitAmount * row.quantity) / months), currency: row.currency };
}

/** The rows `countsTowardMrr` accepts, as a match condition. */
export const MRR_MATCH: Condition = { source: SubscriptionSource.Stripe, status: { $in: [...MRR_STATUSES] } };

/**
 * Facet stages that sum the billed amount of the rows matching `match` per (currency, interval, priced)
 * group plus `by` keys. Normalizing happens in `mrrTotal`, which keeps the pipeline to $group and $sum.
 */
export function billedGroupStages(match: Condition, by: Record<string, string> = {}): Condition[] {
  return [
    { $match: match },
    {
      $group: {
        // $ifNull folds a missing mirror field into null, so rows written before the mirror group as unpriced.
        _id: {
          ...Object.fromEntries(Object.entries(by).map(([key, field]) => [key, { $ifNull: [field, null] }])),
          currency: { $ifNull: ['$currency', null] },
          interval: { $ifNull: ['$interval', null] },
          intervalCount: { $ifNull: ['$intervalCount', null] },
          priced: { $ne: [{ $ifNull: ['$unitAmount', null] }, null] },
        },
        billed: { $sum: { $multiply: [{ $ifNull: ['$unitAmount', 0] }, '$quantity'] } },
        count: { $sum: 1 },
      },
    },
  ];
}

export function mrrGroupStages(within?: Condition, by?: Record<string, string>): Condition[] {
  return billedGroupStages(within ? { $and: [MRR_MATCH, within] } : MRR_MATCH, by);
}

export type MrrGroup<Key extends Record<string, unknown> = Record<never, never>> = {
  _id: Key & { currency: string | null; interval: string | null; intervalCount: number | null; priced: boolean };
  /** unitAmount x quantity summed over the group: minor units per billing period. */
  billed: number;
  count: number;
};

/** Totals `mrrGroupStages` output in MRR_CURRENCY; other currencies and unpriced rows are counted instead. */
export function mrrTotal<Key extends Record<string, unknown>>(
  groups: readonly MrrGroup<Key>[]
): AdminSubscriptionsMrrTotal {
  let amount = 0;
  let unpriced = 0;
  let otherCurrency = 0;
  for (const { _id: group, billed, count } of groups) {
    if (group.currency !== null && group.currency !== MRR_CURRENCY) {
      otherCurrency += count;
      continue;
    }
    const months = monthsPerPeriod(group.interval, group.intervalCount);
    if (!group.priced || group.currency === null || months === null) {
      unpriced += count;
      continue;
    }
    amount += billed / months;
  }
  return { currency: MRR_CURRENCY, amount: Math.round(amount), unpriced, otherCurrency };
}

/** `mrrTotal` per value of one `by` key, with its row count; a missing value is keyed `null`. */
export function mrrTotalsBy<Key extends string>(
  groups: readonly MrrGroup<Record<Key, unknown>>[],
  key: Key
): Map<string | null, { count: number; mrr: AdminSubscriptionsMrrTotal }> {
  const byValue = new Map<string | null, MrrGroup<Record<Key, unknown>>[]>();
  for (const group of groups) {
    const value = group._id[key];
    const id = value === null || value === undefined ? null : String(value);
    byValue.set(id, [...(byValue.get(id) ?? []), group]);
  }
  return new Map(
    [...byValue].map(([value, members]) => [
      value,
      { count: members.reduce((sum, group) => sum + group.count, 0), mrr: mrrTotal(members) },
    ])
  );
}
