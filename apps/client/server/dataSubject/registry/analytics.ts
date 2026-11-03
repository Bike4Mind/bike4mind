import type { DataHolderRegistry } from '../types';

export const analyticsHolders = {
  AnalyticsDaily: {
    kind: 'noUserData',
    note: 'Platform-wide daily counts (signups, DAU/WAU/MAU, requests by feature); no per-person rows.',
  },
  // Per-user daily activity counters; the charges themselves are on the credit ledger.
  AnalyticsUserDay: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
} satisfies DataHolderRegistry;
