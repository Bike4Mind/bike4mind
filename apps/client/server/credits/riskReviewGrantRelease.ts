import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

/**
 * Pays the signup tranche the signup grant policy withheld for review, as an admin approves the
 * account in the risk review queue (admin/signup-risk-reviews). Pays up to the full tranche, not the
 * unlock remainder, which the account still earns the usual way. Returns the credits paid; 0 when
 * nothing was held. The validator re-checks the hold inside the payout transaction, so a concurrent
 * release cannot pay twice. Throws when the tranche stays held, so the caller does not approve.
 */
export async function releaseRiskReviewedSignupGrant(
  userId: string,
  {
    reason,
    audit,
  }: { reason: string; audit: (input: { credits: number; creditTransactionId?: string }) => Promise<void> }
): Promise<number> {
  const user = await userRepository.findById(userId);
  // Only while the review is pending, so a stale request cannot pay an account already approved or banned.
  if (user?.riskScore?.reviewState !== 'pending' || !userService.isSignupGrantHeldForReview(user)) return 0;
  const result = await userService.unlockSignupGrant(userId, 'admin', {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason,
    validators: {
      admin: async current =>
        userService.isSignupGrantHeldForReview(current) && { cumulativeCredits: current.signupGrant.signupCredits },
    },
    audit,
  });
  if (result.creditsGranted > 0) return result.creditsGranted;
  // A domain or burst hold can withhold even an admin payout; approving then would drop the account
  // from the queue with the tranche still held, so fail it and leave it pending for a retry.
  const after = await userRepository.findById(userId);
  if (after && userService.isSignupGrantHeldForReview(after))
    throw new Error('Signup grant is still withheld; release its signup hold before approving');
  return 0;
}
