import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType } from './CreditHolderTypes';

/**
 * Where a credit lot's grant originated. Drives the expiry policy applied at
 * stamp time (see stampCreditLot): pack/legacy get a 12-month expiry,
 * everything else gets 90 days.
 */
export const CreditLotSources = ['pack', 'subscription', 'promo', 'transfer', 'legacy'] as const;
export type CreditLotSource = (typeof CreditLotSources)[number];

/**
 * A dated-expiry slice of a credit grant. Parallel accounting ledger -
 * never gates a charge. `currentCredits` on the holder remains the sole
 * source of truth for balance/reserve/settle; lots are reconciled against it
 * by the daily sweep (see creditLotSweep cron).
 */
export const CreditLot = z.object({
  id: z.string().optional(),
  ownerId: z.string(),
  ownerType: z.enum(CreditHolderType),
  source: z.enum(CreditLotSources),
  /**
   * Original grant amount. Never mutated except by a clawback (dispute/refund),
   * which reduces it to reflect the credits that were taken back.
   */
  amount: z.number(),
  expiresAt: z.date(),
  /**
   * Current FIFO consumption estimate while live; refunds can lower it.
   * A stale sweep retires the lot and sets this to amount.
   */
  consumedAssigned: z.number().default(0),
  /** First stale reconciliation. Absence does not imply settled consumption. */
  settledAt: z.date().optional(),
  /**
   * The grant's Stripe reference (payment intent id), when one exists.
   * Clawback handlers look up lots by this field.
   */
  stripeRef: z.string().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type ICreditLot = z.infer<typeof CreditLot>;

export type ICreditLotDocument = ICreditLot & IMongoDocument;

export interface ICreditLotRepository extends IBaseRepository<ICreditLotDocument> {
  findByOwner(ownerId: string, ownerType: CreditHolderType): Promise<ICreditLotDocument[]>;
  findByStripeRef(stripeRef: string): Promise<ICreditLotDocument[]>;
}
