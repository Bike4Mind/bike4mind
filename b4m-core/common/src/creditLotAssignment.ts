import type { CreditLotSource } from './types/entities/CreditLotTypes';
import type { IUsageFundingBreakdown, UsageFundingSource } from './types/entities/UsageEventTypes';

/**
 * Shared soonest-to-expire-first consumption assignment for the daily sweep
 * (apps/workers/src/cron/creditLotSweep.ts), GET /api/credits/balance and the
 * usage-event funding stamp (UsageEventRepository.record).
 * The sweep separately preserves lots explicitly settled by a stale run.
 */
export interface CreditLotLike {
  amount: number;
}

export interface AssignedCreditLot<T extends CreditLotLike> {
  lot: T;
  /** This run's soonest-first assignment for the lot (0..lot.amount). */
  consumedAssigned: number;
  /** Unassigned portion of the lot's amount (lot.amount - consumedAssigned). */
  remaining: number;
}

/**
 * Total cumulative consumption to attribute across a holder's lots:
 * everything ever granted minus what's left, clamped to zero so a holder
 * whose lots under-count history (e.g. an admin absolute-set top-up) never
 * produces a negative assignment target.
 */
export function computeConsumption(lots: CreditLotLike[], currentCredits: number): number {
  const totalGranted = lots.reduce((sum, lot) => sum + lot.amount, 0);
  return Math.max(0, totalGranted - currentCredits);
}

/**
 * Assign `consumption` across `lots` soonest-expiry-first. Callers must pass
 * lots already sorted ascending by expiresAt - this function only walks the
 * given order, it does not sort.
 */
export function assignConsumptionFIFO<T extends CreditLotLike>(lots: T[], consumption: number): AssignedCreditLot<T>[] {
  let remaining = Math.max(0, consumption);
  return lots.map(lot => {
    const consumedAssigned = Math.min(lot.amount, remaining);
    remaining -= consumedAssigned;
    return { lot, consumedAssigned, remaining: lot.amount - consumedAssigned };
  });
}

/** Legacy lots are the migration backfill of pre-lot balances, so their origin is not known. */
export const FUNDING_SOURCE_BY_LOT_SOURCE: Record<CreditLotSource, UsageFundingSource> = {
  pack: 'purchased',
  subscription: 'subscription',
  promo: 'granted',
  transfer: 'granted',
  legacy: 'unknown',
};

export interface FundingLotLike extends CreditLotLike {
  source: CreditLotSource;
  fundingSource?: UsageFundingSource;
  settledAt?: Date;
}

/**
 * Split a charge that has just been debited across the funding sources of the lots it drew
 * from. Under the soonest-expiry-first assignment the newest charge occupies the last
 * `chargedCredits` of cumulative consumption, so this returns the sources of the lots that
 * slice falls in. Whatever the lots cannot cover (consumption beyond every lot, e.g. a user
 * in debt, or a balance the lots under-count) is `unknown`. Lots must be sorted ascending by
 * expiresAt, as for assignConsumptionFIFO.
 *
 * A lot settled by the sweep's stale run is fully consumed (the sweep debited its remainder),
 * so it is left out: otherwise a later refund would reopen it and attribute new spend to
 * credits that already expired, which the sweep itself never does.
 */
export function attributeChargeToFundingSources(
  lots: FundingLotLike[],
  currentCredits: number,
  chargedCredits: number
): IUsageFundingBreakdown {
  const breakdown: IUsageFundingBreakdown = { granted: 0, purchased: 0, subscription: 0, unknown: 0 };
  const charged = Math.max(0, chargedCredits);
  const liveLots = lots.filter(lot => !lot.settledAt);
  const consumption = computeConsumption(liveLots, currentCredits);
  const sliceStart = Math.max(0, consumption - charged);

  let lotStart = 0;
  let attributed = 0;
  for (const lot of liveLots) {
    const lotEnd = lotStart + lot.amount;
    const overlap = Math.max(0, Math.min(lotEnd, consumption) - Math.max(lotStart, sliceStart));
    breakdown[lot.fundingSource ?? FUNDING_SOURCE_BY_LOT_SOURCE[lot.source]] += overlap;
    attributed += overlap;
    lotStart = lotEnd;
  }

  breakdown.unknown += charged - attributed;
  return breakdown;
}
