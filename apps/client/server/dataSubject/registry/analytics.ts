import type { DataHolderRegistry } from '../types';

export const analyticsHolders = {
  // Platform-wide daily counts. The one per-person field is the day's internal (staff/system) account
  // ids, kept so WAU/MAU can be re-derived as a union; erasure pulls the id and leaves the counts.
  AnalyticsDaily: {
    kind: 'holder',
    references: [{ path: 'internal.userIds', matchBy: 'userId', action: 'pullFromArray' }],
  },
  AnalyticsHop: {
    kind: 'pseudonymous',
    note: 'Keyed by a random hop id; the visitor is a consent-gated hash and session ids, never a user id.',
  },
  // Per-user daily activity counters; the charges themselves are on the credit ledger.
  AnalyticsUserDay: {
    kind: 'holder',
    references: [{ path: 'userId', matchBy: 'userId', action: 'deleteDocument' }],
  },
} satisfies DataHolderRegistry;
