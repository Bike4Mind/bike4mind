import { userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';

/**
 * Domain signup credits are withheld while a grant block is on and their triggers are one-shot, so a lifted
 * block re-runs the step. The credit transactionId and the free-credit claim make a repeat a no-op for an
 * account that already received them; the block gate inside the grant still applies. Never throws: the
 * unblock has already committed.
 */
export async function rerunDomainGrantAfterUnblock(userId: string, logger: Logger = Logger.globalInstance) {
  try {
    const user = await userRepository.findById(userId);
    if (!user?.emailVerified || !user.email) return;
    await applySignupDomainGrant({ userId, email: user.email, trigger: 'admin-unblock', logger });
  } catch (error) {
    logger.error(`Domain signup grant re-run after unblock failed for user ${userId}`, error);
  }
}
