/**
 * Pass-through stand-ins for the @bike4mind/database exports reserveRequestCredits now writes through
 * (a pending-hold row inside a transaction), for route tests that mock @bike4mind/database wholesale
 * and do not exercise the sweep. Spread into the mock factory via a dynamic import. The new-account
 * spend cap's adapters ride along: no samples and no settings rows, so it reads defaults and never refuses.
 */
export const pendingCreditHoldFake = {
  pendingCreditHoldRepository: {
    record: async () => ({ id: 'pending-hold' }),
    claim: async () => ({ id: 'pending-hold' }),
    markSettled: async () => true,
    findSettlement: async () => null,
  },
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  newAccountSpendCapAdapters: {
    adminSettings: { findAll: async () => [], findBySettingNames: async () => [] },
    personalSpendSince: async () => [],
  },
};
