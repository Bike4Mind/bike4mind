/**
 * Shared soonest-to-expire-first consumption assignment for the daily sweep
 * (apps/workers/src/cron/creditLotSweep.ts) and GET /api/credits/balance.
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
