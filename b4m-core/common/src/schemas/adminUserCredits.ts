import * as z from 'zod';
import { COMPLETION_SOURCES } from '../types/analytics';
import { CREDIT_ADD_TRANSACTION_TYPES, type CreditTransactionType } from '../types/entities/CreditTransactionTypes';

/**
 * Contracts for the admin user profile's Credits and API keys tabs. The server routes under
 * pages/api/admin/users/[userId]/ (credit-ledger, credit-ledger-export, credit-summary,
 * user-api-keys, revoke-api-keys) and pages/api/admin/user-api-keys/[id]/ (revoke, restore,
 * rotate) produce these shapes; the profile tabs consume them.
 */

/** How the ledger groups transaction types for display and filtering. */
export const ADMIN_LEDGER_KINDS = ['usage', 'api', 'purchase', 'subscription', 'adjustment', 'transfer'] as const;
export type AdminLedgerKind = (typeof ADMIN_LEDGER_KINDS)[number];

// Exhaustive by construction: a new transaction type fails the build here until it is classified,
// so the ledger can never render an "unknown" row.
export const CREDIT_TRANSACTION_KIND = {
  text_generation_usage: 'usage',
  image_generation_usage: 'usage',
  image_edit_usage: 'usage',
  video_generation_usage: 'usage',
  realtime_voice_usage: 'usage',
  tool_usage: 'usage',
  speech_to_text_usage: 'usage',
  text_to_speech_usage: 'usage',
  sound_effects_usage: 'usage',
  music_generation_usage: 'usage',
  completion_api_usage: 'api',
  decision_usage: 'api',
  purchase: 'purchase',
  subscription: 'subscription',
  generic_add: 'adjustment',
  generic_deduct: 'adjustment',
  received_credit: 'transfer',
  transfer_credit: 'transfer',
} as const satisfies Record<CreditTransactionType, AdminLedgerKind>;

/** Every transaction type in a kind, for building the server-side `type: {$in}` filter. */
export function transactionTypesForKind(kind: AdminLedgerKind): CreditTransactionType[] {
  return (Object.keys(CREDIT_TRANSACTION_KIND) as CreditTransactionType[]).filter(
    type => CREDIT_TRANSACTION_KIND[type] === kind
  );
}

/**
 * Writers disagree on the sign of stored deduct rows, so the ledger derives it from the type:
 * add types are positive, everything else negative.
 */
export function signedCredits(type: CreditTransactionType, credits: number): number {
  const magnitude = Math.abs(credits);
  return CREDIT_ADD_TRANSACTION_TYPES.includes(type) ? magnitude : -magnitude;
}

export const ADMIN_LEDGER_PAGE_SIZE = 50;
/** Hard cap on one CSV export; the UI states it next to the export button. */
export const ADMIN_LEDGER_EXPORT_MAX_ROWS = 10_000;

const ledgerFilterShape = {
  kind: z.enum(ADMIN_LEDGER_KINDS).optional(),
  /** Exact model id as stored on the transaction. */
  model: z.string().trim().min(1).max(200).optional(),
  source: z.enum(COMPLETION_SOURCES).optional(),
  /** First UTC day included, YYYY-MM-DD. */
  from: z.iso.date().optional(),
  /** Last UTC day included, YYYY-MM-DD. */
  to: z.iso.date().optional(),
};

// ISO dates compare correctly as strings.
const fromNotAfterTo = (filter: { from?: string; to?: string }) =>
  !filter.from || !filter.to || filter.from <= filter.to;
const RANGE_ORDER_ISSUE = { message: 'The start date must not be after the end date', path: ['from'] };

/** The ledger filter shared by the page route and the CSV export, so an export follows the view. */
export const adminLedgerFilterSchema = z.object(ledgerFilterShape).refine(fromNotAfterTo, RANGE_ORDER_ISSUE);
export type AdminLedgerFilter = z.infer<typeof adminLedgerFilterSchema>;

export const adminLedgerQuerySchema = z
  .object({
    ...ledgerFilterShape,
    /** Opaque cursor from the previous page's `nextCursor`. */
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine(fromNotAfterTo, RANGE_ORDER_ISSUE);
export type AdminLedgerQuery = z.infer<typeof adminLedgerQuerySchema>;

/**
 * Whether a filter keeps the ledger contiguous, so a running balance can be derived. A date range only
 * trims the ends; kind, model and source drop rows from the middle.
 */
export const isContiguousLedgerFilter = (filter: AdminLedgerFilter): boolean =>
  !filter.kind && !filter.model && !filter.source;

export const adminLedgerRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  kind: z.enum(ADMIN_LEDGER_KINDS),
  createdAt: z.string(),
  /** Signed: positive adds credits, negative spends or removes them. */
  credits: z.number(),
  /**
   * Balance right after this row. Present on a contiguous view (see isContiguousLedgerFilter; rebuilt
   * back from the current balance) and on admin adjustments (recorded at write time); absent otherwise.
   */
  balanceAfter: z.number().optional(),
  model: z.string().optional(),
  source: z.string().optional(),
  apiKeyId: z.string().optional(),
  apiKeyPrefix: z.string().optional(),
  /** The usage event's request id, stamped on completion API rows. */
  requestId: z.string().optional(),
  /** The chat message (quest) a web usage row paid for. */
  questId: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  /** Prompt-cache tokens, disjoint from inputTokens and priced on their own. */
  cacheReadTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  /** The client conversation a completion API row belongs to, when the client sent one. */
  sessionId: z.string().optional(),
  /** Distinct tools the model called on a completion API row. */
  toolNames: z.array(z.string()).optional(),
  description: z.string().optional(),
  /** Machine reason on generic_* rows, e.g. admin_adjustment or credit_expiry. */
  reason: z.string().optional(),
  /** The acting admin's stated reason on an admin adjustment. */
  note: z.string().optional(),
  actorId: z.string().optional(),
  actorName: z.string().optional(),
});
export type AdminLedgerRow = z.infer<typeof adminLedgerRowSchema>;

/** GET /api/admin/users/[userId]/credit-ledger */
export const adminLedgerPageSchema = z.object({
  rows: z.array(adminLedgerRowSchema),
  nextCursor: z.string().nullable(),
});
export type AdminLedgerPage = z.infer<typeof adminLedgerPageSchema>;

/**
 * AI spend of one model or source over the trailing 7, 30 and 90 UTC days including today: the same
 * windows as the tail of `daily`, so a breakdown and the by-day chart total the same.
 */
export const adminSpendBucketSchema = z.object({
  /** The model or source; null when the transaction did not record one. */
  key: z.string().nullable(),
  last7d: z.number(),
  last30d: z.number(),
  last90d: z.number(),
});
export type AdminSpendBucket = z.infer<typeof adminSpendBucketSchema>;

/** GET /api/admin/users/[userId]/credit-summary. Spend counts AI usage rows (kinds usage and api). */
export const adminCreditSummarySchema = z.object({
  balance: z.number(),
  spent: z.object({ last24h: z.number(), last7d: z.number(), last30d: z.number() }),
  topModel30d: z.object({ model: z.string(), credits: z.number() }).nullable(),
  lastTopUp: z.object({ at: z.string(), credits: z.number(), type: z.enum(['purchase', 'subscription']) }).nullable(),
  /** One entry per UTC day, oldest first, zero-filled, covering the last 90 days including today. */
  daily: z.array(z.object({ date: z.string(), credits: z.number() })),
  /** Every model with spend in the last 90 days, largest 90-day spend first. */
  byModel: z.array(adminSpendBucketSchema),
  /** Every source with spend in the last 90 days, largest 90-day spend first. */
  bySource: z.array(adminSpendBucketSchema),
});
export type AdminCreditSummary = z.infer<typeof adminCreditSummarySchema>;

export const API_KEY_ACCESS_BASES = [
  'admin',
  'developer',
  'open_to_all',
  'paid_subscription',
  'credit_purchase',
  'no_paid_subscription',
  'disabled',
] as const;

/** Why the API key subscription gate does or does not let this user mint and use personal keys. */
export const adminApiKeyAccessSchema = z.object({
  mode: z.enum(['all', 'paid', 'disabled']),
  allowed: z.boolean(),
  basis: z.enum(API_KEY_ACCESS_BASES),
});
export type AdminApiKeyAccess = z.infer<typeof adminApiKeyAccessSchema>;

export const adminApiKeyRequestCountsSchema = z.object({ last24h: z.number(), last7d: z.number() });
export type AdminApiKeyRequestCounts = z.infer<typeof adminApiKeyRequestCountsSchema>;

/** POST /api/admin/user-api-keys/[id]/rotate. The secret is shown once and never returned again. */
export const adminRotateApiKeyResponseSchema = z.object({
  keyId: z.string(),
  keyPrefix: z.string(),
  secret: z.string(),
});
export type AdminRotateApiKeyResponse = z.infer<typeof adminRotateApiKeyResponseSchema>;

/** POST /api/admin/users/[userId]/revoke-api-keys */
export const adminRevokeAllApiKeysResponseSchema = z.object({ revokedKeyIds: z.array(z.string()) });
export type AdminRevokeAllApiKeysResponse = z.infer<typeof adminRevokeAllApiKeysResponseSchema>;

/** Minutes after an admin revoke during which the same admin may restore the key (backs Undo). */
export const ADMIN_API_KEY_RESTORE_WINDOW_MINUTES = 5;
