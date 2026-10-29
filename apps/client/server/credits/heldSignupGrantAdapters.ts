import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  signupGrantReleaseRepository,
  userRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import type { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { createSignupRiskCollector } from '@server/auth/signupNetworkLimits';

export const heldGrantBatches = signupGrantReleaseRepository;

export function buildHeldGrantAdapters(logger: Logger): userService.HeldGrantAdapters {
  return {
    grant: {
      db: {
        adminSettings: adminSettingsRepository,
        creditTransactions: creditTransactionRepository,
        creditLots: creditLotRepository,
        users: userRepository,
        signupProtection,
      },
      reason: 'Held signup grant released',
      logger,
      collectRiskSignals: createSignupRiskCollector(undefined),
    },
    clearPending: id => userRepository.clearPendingFreeCreditGrant(id),
  };
}
