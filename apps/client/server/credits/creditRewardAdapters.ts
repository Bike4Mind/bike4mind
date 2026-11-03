import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  heldCreditRewardRepository,
  userRepository,
} from '@bike4mind/database';
import type { creditService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

/** Adapters for creditService.payCreditReward / releaseHeldCreditRewards. */
export const buildCreditRewardAdapters = (
  options: Pick<creditService.PayCreditRewardAdapters, 'duplicateTransactionId'> = {}
): creditService.PayCreditRewardAdapters => ({
  db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
  creditHolderMethods: userRepository,
  heldRewards: heldCreditRewardRepository,
  users: userRepository,
  adminSettings: adminSettingsRepository,
  signupProtection,
  ...options,
});
