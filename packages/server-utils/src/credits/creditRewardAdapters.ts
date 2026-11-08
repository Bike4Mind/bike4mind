import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  heldCreditRewardRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { creditService } from '@bike4mind/services';
import { signupProtection } from '../auth/signupProtection';

/**
 * Adapters for creditService.payCreditReward / releaseHeldCreditRewards. Pass `inTransaction` when the
 * caller already wraps the call in withTransaction, so payouts do not open a second one.
 */
export const buildCreditRewardAdapters = ({
  inTransaction = false,
  ...options
}: Pick<creditService.PayCreditRewardAdapters, 'duplicateTransactionId'> & {
  inTransaction?: boolean;
} = {}): creditService.PayCreditRewardAdapters => ({
  db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
  creditHolderMethods: userRepository,
  heldRewards: heldCreditRewardRepository,
  users: userRepository,
  adminSettings: adminSettingsRepository,
  signupProtection,
  ...(inTransaction ? {} : { withTransaction: <T>(fn: () => Promise<T>) => withTransaction(() => fn()) }),
  ...options,
});
