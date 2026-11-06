import fs from 'node:fs';
import path from 'node:path';
import { userRepository } from '@bike4mind/database';
import type Stripe from 'stripe';
import { isInsideRepo } from './apiRouteInventory';
import type { PurchaseClassification } from './reconcilePurchaseStamps';

type StripeLookupClient = {
  paymentIntents: Pick<Stripe['paymentIntents'], 'retrieve'>;
  disputes: Pick<Stripe['disputes'], 'list'>;
};

/**
 * Stripe-backed classifier and owner lookup for reconcilePurchaseStamps. Each payment intent is
 * retrieved once and shared by both lookups. Read-only against Stripe.
 */
export function createStripeLookups(stripe: StripeLookupClient) {
  const intents = new Map<string, Promise<Stripe.PaymentIntent>>();
  const retrieve = (paymentIntentId: string) => {
    let intent = intents.get(paymentIntentId);
    if (!intent) {
      intent = stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ['latest_charge'],
      }) as Promise<Stripe.PaymentIntent>;
      intents.set(paymentIntentId, intent);
    }
    return intent;
  };

  /** Full refund or a lost dispute reverses; a partial refund or an open or won dispute does not. Any error is unknown. */
  const classifyPurchase = async (paymentIntentId: string): Promise<PurchaseClassification> => {
    try {
      const charge = (await retrieve(paymentIntentId)).latest_charge;
      if (charge && typeof charge === 'object' && charge.refunded === true)
        return { kind: 'reversed', reason: 'refunded' };
      const disputes = await stripe.disputes.list({ payment_intent: paymentIntentId, limit: 100 });
      if (disputes.data.some(dispute => dispute.status === 'lost')) return { kind: 'reversed', reason: 'dispute_lost' };
      return { kind: 'standing' };
    } catch (error) {
      return { kind: 'unknown', error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** The user whose Stripe customer paid this intent; null for an org customer or no customer. */
  const resolveOwnerByPaymentIntent = async (paymentIntentId: string): Promise<string | null> => {
    const customer = (await retrieve(paymentIntentId)).customer;
    const customerId = typeof customer === 'string' ? customer : customer?.id;
    if (!customerId) return null;
    const user = await userRepository.findByStripeCustomerId(customerId);
    return user ? user.id : null;
  };

  return { classifyPurchase, resolveOwnerByPaymentIntent };
}

/**
 * Validates --report: an absolute path whose resolved location is outside `repoRoot`, so a report
 * listing user ids is not written into the working tree. Throws with the reason otherwise.
 */
export function resolveReportPath(raw: string, repoRoot: string): string {
  if (!raw || !path.isAbsolute(raw)) throw new Error('--report needs an absolute path outside the repository');
  const dir = path.dirname(raw);
  const target = path.join(fs.existsSync(dir) ? fs.realpathSync(dir) : dir, path.basename(raw));
  if (isInsideRepo(target, fs.realpathSync(repoRoot))) {
    throw new Error(`--report must point outside the repository, got ${target}`);
  }
  return target;
}
