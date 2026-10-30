import { creditTransactionRepository, organizationRepository, userRepository } from '@bike4mind/database';
import type { OperationalBillingAdapters } from '@bike4mind/services';
import { activePlanResolver } from '@server/entitlements/activeSubscriptions';

/** What a chat host wires as `db.operationalBilling` so tool-internal operational spend can debit. */
export const operationalBillingAdapters: OperationalBillingAdapters = {
  creditTransactions: creditTransactionRepository,
  users: userRepository,
  organizations: organizationRepository,
  activePlans: activePlanResolver,
};
