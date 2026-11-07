import type { DataHolderRegistry } from '../types';

export const analyticsHolders = {
  // Platform-wide daily counts; only the internal accounts' ids are listed, so WAU/MAU can be re-derived.
  AnalyticsDaily: {
    kind: 'holder',
    references: [{ path: 'internal.userIds', matchBy: 'userId', action: 'pullFromArray' }],
  },
  AnalyticsHop: {
    kind: 'pseudonymous',
    note: "Cross-product click record keyed by a random hop id, visit ids and the source product's visitor hash; no user id. A signup bound to it records the hop on the User document.",
  },
  // Per-user daily activity counters; the charges themselves are on the credit ledger.
  AnalyticsUserDay: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
} satisfies DataHolderRegistry;
