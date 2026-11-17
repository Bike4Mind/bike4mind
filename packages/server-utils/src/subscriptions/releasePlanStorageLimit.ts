import { withTransaction } from '@bike4mind/db-core';
import { userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { subscriptionRepository } from '../models/Subscription';
import { emitMetric } from '../utils/cloudwatch';

/**
 * Takes the plan storage allowance away from a user whose subscription has ended (a status in
 * TERMINAL_SUBSCRIPTION_STATUSES, or customer.subscription.deleted): clears
 * `planStorageLimit`, so the enforced limit falls back to the manual override, or to
 * DEFAULT_STORAGE_LIMIT_MB without one. Nothing stored is deleted; a user left over the new limit
 * keeps read and delete access and the upload checks refuse new bytes.
 *
 * Skipped while another active or trialing subscription of the user exists, so a plan switch that
 * ends the old subscription after the new one started keeps the new plan's limit. Idempotent, so the
 * `customer.subscription.updated` and `customer.subscription.deleted` paths can both call it.
 * Never throws: the subscription write it follows has already committed.
 */
export async function releasePlanStorageLimit(
  userId: string,
  endedSubscriptionId: string,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
): Promise<void> {
  try {
    const outcome = await withTransaction(async () => {
      if (await subscriptionRepository.hasOtherGrantingUserSubscription(userId, endedSubscriptionId)) {
        return 'retained' as const;
      }
      return (await userRepository.clearPlanStorageLimit(userId)) ? ('cleared' as const) : ('missing' as const);
    });
    // Log after commit, since the transaction callback may run more than once.
    if (outcome === 'retained') {
      logger.info(
        `Keeping plan storage limit for user ${userId}: another subscription is still live after ${endedSubscriptionId} ended`
      );
      return;
    }
    if (outcome === 'cleared') {
      logger.info(`Cleared plan storage limit for user ${userId} after subscription ${endedSubscriptionId} ended`);
    } else {
      logger.warn(`Plan storage limit not cleared: user ${userId} not found for subscription ${endedSubscriptionId}`);
    }
  } catch (error) {
    logger.error(`Failed to clear plan storage limit for user ${userId}`, { error });
    await emitMetric('Lumina5/Entitlements', 'PlanStorageLimitFailed', 1, { reason: 'clear_failed' });
  }
}
