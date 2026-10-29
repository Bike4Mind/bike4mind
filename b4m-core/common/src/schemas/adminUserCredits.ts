import * as z from 'zod';
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

export const adminLedgerQuerySchema = z.object({
  kind: z.enum(ADMIN_LEDGER_KINDS).optional(),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type AdminLedgerQuery = z.infer<typeof adminLedgerQuerySchema>;

export const adminLedgerRowSchema = z.object({
  id: z.string(),
  type: z.string(),
  kind: z.enum(ADMIN_LEDGER_KINDS),
  createdAt: z.string(),
  /** Signed: positive adds credits, negative spends or removes them. */
  credits: z.number(),
  /**
   * Balance right after this row. Present on the unfiltered view (rebuilt back from the current
   * balance) and on admin adjustments (recorded at write time); absent otherwise.
   */
  balanceAfter: z.number().optional(),
  model: z.string().optional(),
  source: z.string().optional(),
  apiKeyId: z.string().optional(),
  apiKeyPrefix: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
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

/** GET /api/admin/users/[userId]/credit-summary. Spend counts AI usage rows (kinds usage and api). */
export const adminCreditSummarySchema = z.object({
  balance: z.number(),
  spent: z.object({ last24h: z.number(), last7d: z.number(), last30d: z.number() }),
  topModel30d: z.object({ model: z.string(), credits: z.number() }).nullable(),
  lastTopUp: z.object({ at: z.string(), credits: z.number(), type: z.enum(['purchase', 'subscription']) }).nullable(),
  /** One entry per UTC day, oldest first, zero-filled, covering the last 90 days including today. */
  daily: z.array(z.object({ date: z.string(), credits: z.number() })),
});
export type AdminCreditSummary = z.infer<typeof adminCreditSummarySchema>;

export const API_KEY_ACCESS_BASES = [
  'admin',
  'developer',
  'open_to_all',
  'paid_subscription',
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
