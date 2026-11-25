import { z } from 'zod';

export const ECONOMY_FLOWS = [
  'purchased',
  'subscription',
  'granted',
  'consumed',
  'expired',
  'reversed',
  'adjustments',
  'refunds',
  'transfers',
  'unknown',
  'non_balance',
] as const;
export const ECONOMY_FLOW_LABELS: Record<(typeof ECONOMY_FLOWS)[number], string> = {
  purchased: 'Purchased',
  subscription: 'Subscription-issued',
  granted: 'Promotional / granted',
  consumed: 'Consumed',
  expired: 'Expired',
  reversed: 'Reversed / clawed back',
  adjustments: 'Explicit adjustments',
  refunds: 'Credit refunds',
  transfers: 'Owner transfers',
  unknown: 'Unknown movement',
  non_balance: 'Pending / failed purchases',
};
export const EconomyQuery = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    ownerType: z.enum(['all', 'User', 'Organization', 'Agent']).default('all'),
    flow: z.enum(ECONOMY_FLOWS).optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .refine(
    q => {
      const duration = Date.parse(q.to) - Date.parse(q.from);
      return duration > 0 && duration <= 366 * 86400000;
    },
    { message: 'Select a positive window of at most 366 days' }
  );

export type EconomyQueryInput = z.infer<typeof EconomyQuery>;
export type EconomyFlow = (typeof ECONOMY_FLOWS)[number];
export const EconomyRow = z.object({
  id: z.string(),
  at: z.string(),
  ownerId: z.string(),
  ownerType: z.string(),
  type: z.string(),
  reason: z.string().nullable(),
  credits: z.number(),
  delta: z.number(),
  flow: z.enum(ECONOMY_FLOWS),
});
const Funding = z.object({ purchased: z.number(), subscription: z.number(), granted: z.number(), unknown: z.number() });
export const EconomyReport = z.object({
  from: z.string(),
  to: z.string(),
  asOf: z.string(),
  ownerType: z.string(),
  flows: z.array(z.object({ flow: z.enum(ECONOMY_FLOWS), credits: z.number(), rows: z.number() })),
  netMovement: z.number(),
  transactionCount: z.number(),
  balances: z.object({
    opening: z.null(),
    closing: z.null(),
    held: z.null(),
    reconciliationDifference: z.null(),
    currentAvailable: z.number().nullable(),
    holders: z.number(),
    missingBalances: z.number(),
  }),
  funding: z.object({
    consumption: Funding,
    usageDebited: z.number(),
    usageRows: z.number(),
    stampedRows: z.number(),
    invalidOrMissingRows: z.number(),
    ledgerConsumption: z.number(),
    ledgerUsageDifference: z.number(),
    currentLotRemainingEstimate: Funding,
    lotCount: z.number(),
  }),
  cohorts: z.array(
    z.object({
      days: z.number(),
      maturePurchases: z.number(),
      issuedCredits: z.number(),
      attributablePurchases: z.literal(0),
      consumedCredits: z.null(),
    })
  ),
  limitations: z.array(z.string()),
});
export const EconomyPage = z.object({ rows: z.array(EconomyRow), total: z.number() });
export type EconomyReportData = z.infer<typeof EconomyReport>;
export type EconomyRowData = z.infer<typeof EconomyRow>;

export const ECONOMY_LIMITATIONS = [
  'Credit units only. No money or revenue is inferred from grants or purchase amounts.',
  'Window is [from, to) in UTC. All owners includes individuals, organizations, agents and internal accounts; no internal-account exclusion is inferred.',
  'Ledger equation: closing = opening + purchased + subscription + granted + refunds + adjustments + unknown + signed transfers - consumption - expiry - clawbacks. Flow values below are signed deltas. Transfers are not issuance; a filtered owner scope or period may contain only one side.',
  'Opening, closing, held and independent reconciliation difference are unavailable: there are no immutable historical balance/hold snapshots. Current available balances are read separately, not reconstructed historical balances. Missing balances remain unknown.',
  'Consumption funding is the recorded usage-event allocation, not exact historical purchase attribution. Stamps use a FIFO lot snapshot, may overlap under concurrent calls, and may be affected by reservations. Write-offs are removed proportionally; invalid or absent stamps remain unknown.',
  'Usage events and ledger charges are separate best-effort writes, not a 1:1 join. Their difference is shown, not reassigned to a funding category. Refunds are separate ledger flows, not negative provider consumption.',
  'Current lot remaining is an estimate from live, unsettled lots (amount minus consumedAssigned), not a holder balance or a selected-period closing balance. Sweeps, missing lots, transfers and clawbacks can skew it; legacy/transfer funding remains unknown unless explicitly recorded.',
  '7/30-day cohorts count completed purchases in the selected window mature as of the report time. Consumption and attributable coverage are unavailable: no immutable purchase-to-consumption links exist. Expiry/clawback is never substituted for consumption. Reversed purchases remain in original issuance counts; clawbacks are separate flows.',
  'Reads are bounded by time and query timeouts, but are not an atomic cross-collection snapshot. Existing writer idempotency keys reject retried ledger writes; identical unkeyed historical rows cannot safely be deduplicated.',
];
