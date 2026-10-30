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
 * release cannot pay twice.
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
  return result.creditsGranted;
}
