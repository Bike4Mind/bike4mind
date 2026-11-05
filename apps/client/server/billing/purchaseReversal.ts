import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType, type PurchaseReversalReason } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { adminOwnerSlackRef } from '@server/integrations/slack/subscriptionLifecycle';
import { Resource } from 'sst';

export type PurchaseReversalOutcome = 'no_purchase' | 'not_user' | 'no_stamp' | 'kept' | 'revoked';

/**
 * Records that a credit purchase was fully refunded or lost a dispute, and clears the buyer's
 * lastCreditsPurchasedAt (the paid-standing stamp) once no unreversed purchase backs it. Every step is
 * idempotent, so a Stripe redelivery is safe; throws on a DB error so the webhook rethrows and Stripe retries.
 */
export async function reversePurchaseStanding(
  { paymentIntentId, reason }: { paymentIntentId: string; reason: PurchaseReversalReason },
  logger: Logger
): Promise<PurchaseReversalOutcome> {
  const tx = await creditTransactionRepository.markPurchaseReversed(paymentIntentId, reason);
  if (!tx) {
    logger.debug(`No credit purchase for payment intent ${paymentIntentId}, nothing to reverse`);
    return 'no_purchase';
  }
  // Only users carry a purchase stamp today: the webhook grants every credit purchase to a user.
  if (tx.ownerType !== CreditHolderType.User) {
    logger.info(`Marked purchase ${tx.id} reversed (${reason}); owner is not a user, no stamp to revoke`);
    return 'not_user';
  }

  const user = await userRepository.findById(tx.ownerId);
  const stamp = user?.lastCreditsPurchasedAt;
  if (!user || !stamp) {
    logger.info(`Marked purchase ${tx.id} reversed (${reason}); owner ${tx.ownerId} has no purchase stamp`);
    return 'no_stamp';
  }
  if (await creditTransactionRepository.findUnreversedPurchase(user.id, CreditHolderType.User)) {
    logger.info(
      `Marked purchase ${tx.id} reversed (${reason}); user ${user.id} keeps paid standing from another purchase`
    );
    return 'kept';
  }
  if (!(await userRepository.clearPurchaseStampIfUnchanged(user.id, stamp))) {
    logger.info(`Purchase stamp of user ${user.id} changed while reversing ${tx.id}, leaving it`);
    return 'kept';
  }

  logger.info(`Revoked paid standing of user ${user.id}: purchase ${tx.id} reversed (${reason})`);
  // Best-effort: allSettled never rejects, so a websocket failure cannot fail a revocation that landed.
  await Promise.allSettled(
    [['llm', 'models'], ['entitlements']].map(queryKey =>
      sendToClient(user.id, Resource.websocket.managementEndpoint, { action: 'invalidate_query', queryKey })
    )
  );
  await postMessageToSlack(
    `\u2139\uFE0F *Paid Standing Revoked* \u2014 ${reason === 'refunded' ? 'full refund' : 'lost dispute'} of payment ${paymentIntentId}\n*User:* ${adminOwnerSlackRef({ ownerType: SubscriptionOwnerType.User, ownerId: user.id })}`
  );
  return 'revoked';
}
