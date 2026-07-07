import { ICreditLotRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export interface ClawbackCreditLotsAdapters {
  db: {
    creditLots: ICreditLotRepository;
  };
}

/**
 * Kill the matching lot(s) for a Stripe clawback (dispute or refund). This is
 * accounting-only: it edits `lot.amount` so `Σ lot.amount - currentCredits`
 * stays invariant with the clawback that already happened via subtractCredits
 * - it must NEVER itself touch `currentCredits`. No matching lot is a safe
 * no-op (e.g. a subscription grant stamped with an invoice-id ref that
 * doesn't match the dispute's payment intent).
 *
 * Best-effort by design, same rationale as stampCreditLot: a failure here
 * must never fail the clawback that already committed.
 */
export async function clawbackCreditLotsByStripeRef(
  stripeRef: string,
  mode: 'full' | 'proportional',
  clawedCredits: number,
  { db }: ClawbackCreditLotsAdapters
): Promise<void> {
  try {
    const lots = await db.creditLots.findByStripeRef(stripeRef);
    for (const lot of lots) {
      // Dispute (full): kill whatever is left unconsumed. Refund (proportional):
      // remove exactly the clawed amount. Either way, clamp at consumedAssigned
      // so a lot the sweep already partially realized can't be shrunk below
      // what's already been attributed.
      const newAmount =
        mode === 'full' ? lot.consumedAssigned : Math.max(lot.consumedAssigned, lot.amount - clawedCredits);
      if (newAmount === lot.amount) continue;
      await db.creditLots.update({ id: lot.id, amount: newAmount });
    }
  } catch (err) {
    Logger.error('Failed to claw back credit lot', err, { stripeRef, mode, clawedCredits });
  }
}
