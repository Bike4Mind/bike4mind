import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType } from './CreditHolderTypes';
import { COMPLETION_SOURCES, CompletionSource } from '../analytics';

export enum CreditPurchaseStatus {
  Completed = 'completed',
  Pending = 'pending',
  Failed = 'failed',
}

// Base transaction properties
const BaseCreditTransaction = z.object({
  id: z.string().optional(), // MongoDB ObjectId
  ownerId: z.string(),
  ownerType: z.enum(CreditHolderType),
  /**
   * Credits used or added
   */
  credits: z.number(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(), // For additional context
  /**
   * Where this transaction originated - used to break down usage in reports.
   * Optional because legacy rows (and non-completion transactions like
   * purchases/refunds) may not have it set. See CompletionSource in analytics.ts.
   */
  source: z.enum(COMPLETION_SOURCES).optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/**
 * Purchase transaction
 */
export const PurchaseTransaction = BaseCreditTransaction.extend({
  type: z.literal('purchase'),
  /**
   * @deprecated Use ownerId and ownerType instead
   */
  userId: z.string().optional(),
  status: z.enum(CreditPurchaseStatus),
  stripePaymentIntentId: z.string(),
  packageId: z.string().optional(),
  amount: z.number(),
});

/**
 * Credits that are added to a user or organization through a subscription plan
 */
export const SubscriptionCreditTransaction = BaseCreditTransaction.extend({
  type: z.literal('subscription'),
  stripePaymentIntentId: z.string().optional(),
});

/**
 * Credits received from another credit holder
 */
export const ReceivedCreditTransaction = BaseCreditTransaction.extend({
  type: z.literal('received_credit'),
  senderId: z.string(),
  senderType: z.enum(CreditHolderType),
});

/**
 * Generic credit addition transaction for legacy data and flexible use cases
 * Represents any credit addition that doesn't fit specific categories
 * (e.g., admin grants, refunds, adjustments, legacy purchases)
 */
export const GenericCreditAddTransaction = BaseCreditTransaction.extend({
  type: z.literal('generic_add'),
  /**
   * @deprecated Use ownerId and ownerType instead
   */
  userId: z.string().optional(),
  /**
   * Optional reason/source for the transaction (e.g., 'admin_grant', 'refund', 'adjustment', 'legacy_purchase')
   */
  reason: z.string().optional(),
  /**
   * Idempotency key - unique sparse index in the DB prevents duplicate credits on SQS retry.
   * Use deterministic keys like `completion-refund:${qWorkRunId}` or `failed-refund:${qWorkRunId}`.
   * E11000 on this field = already processed (not an error).
   */
  transactionId: z.string().optional(),
});

/**
 * Known reasons for generic credit deductions.
 * New callers should use one of these values - not a free-form string.
 */
export const GenericDeductReasons = [
  'dispute_clawback',
  'refund_clawback',
  'payment_failed_clawback',
  'notebook_curation',
  'manual',
  'admin_adjustment',
  'refund_adjustment',
  'optihashi_reservation',
  'credit_expiry',
] as const;

export type GenericDeductReason = (typeof GenericDeductReasons)[number];

/**
 * Generic credit deduction transaction for legacy data and flexible use cases
 * Represents any credit deduction that doesn't fit specific categories
 * (e.g., admin adjustments, legacy usage, manual deductions)
 */
export const GenericCreditDeductTransaction = BaseCreditTransaction.extend({
  type: z.literal('generic_deduct'),
  /**
   * @deprecated Use ownerId and ownerType instead
   */
  userId: z.string().optional(),
  /**
   * Reason/source for the transaction. Use GenericDeductReasons for new callers.
   */
  reason: z.enum(GenericDeductReasons).optional(),
  /**
   * Stripe dispute ID - set for dispute clawback transactions.
   * Used for idempotency (unique sparse index prevents duplicate clawbacks).
   */
  stripeDisputeId: z.string().optional(),
  /**
   * Stripe refund ID - set for refund clawback transactions.
   * Used for idempotency (unique sparse index prevents duplicate clawbacks).
   */
  stripeRefundId: z.string().optional(),
});

// Usage transactions with service-specific details
export const TextGenerationUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('text_generation_usage'),
  model: z.string(),
  questId: z.string(),
  sessionId: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const ImageGenerationUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('image_generation_usage'),
  model: z.string(),
  questId: z.string(),
  sessionId: z.string(),
});

export const ImageEditUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('image_edit_usage'),
  model: z.string(),
  questId: z.string(),
  sessionId: z.string(),
});

export const VideoGenerationUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('video_generation_usage'),
  model: z.string(),
  questId: z.string(),
  sessionId: z.string(),
});

export const RealtimeVoiceUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('realtime_voice_usage'),
  model: z.string(),
  sessionId: z.string(),
});

export const ToolUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('tool_usage'),
  model: z.string(),
  questId: z.string(),
  sessionId: z.string(),
});

export const CompletionApiUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('completion_api_usage'),
  model: z.string(),
  apiKeyId: z.string().optional(), // Optional - present for API key auth, undefined for JWT
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const SpeechToTextUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('speech_to_text_usage'),
  model: z.string(),
  sessionId: z.string(),
});

export const TextToSpeechUsageTransaction = BaseCreditTransaction.extend({
  type: z.literal('text_to_speech_usage'),
  model: z.string(),
  sessionId: z.string(),
});

export const TransferCreditTransaction = BaseCreditTransaction.extend({
  type: z.literal('transfer_credit'),
  recipientId: z.string(),
  recipientType: z.enum(CreditHolderType),
});

/**
 * Credit transaction
 *
 * IMPORTANT: When adding a new transaction type here, you MUST also update:
 * 1. packages/database/src/models/CreditTransactionModel.ts - Add to the `type` enum
 * 2. packages/database/src/models/CreditTransactionModel.ts - Add any new fields to schema
 * 3. packages/services/src/creditService/subtractCredits.ts - Add handler in switch statement
 * 4. apps/client/app/components/ProfileModal/CreditAnalyticsTabContent.tsx - Add filtering and display logic
 *
 * Failure to sync these files will cause validation errors in MongoDB.
 */
export const CreditTransaction = z.discriminatedUnion('type', [
  PurchaseTransaction,
  SubscriptionCreditTransaction,
  GenericCreditAddTransaction,
  GenericCreditDeductTransaction,
  TextGenerationUsageTransaction,
  ImageGenerationUsageTransaction,
  ImageEditUsageTransaction,
  VideoGenerationUsageTransaction,
  RealtimeVoiceUsageTransaction,
  ToolUsageTransaction,
  CompletionApiUsageTransaction,
  SpeechToTextUsageTransaction,
  TextToSpeechUsageTransaction,
  TransferCreditTransaction,
  ReceivedCreditTransaction,
]);

/**
 * Base credit transaction interface
 */
export type ICreditTransaction = z.infer<typeof CreditTransaction>;

/**
 * Individual transaction type exports
 */
export type IPurchaseTransaction = z.infer<typeof PurchaseTransaction>;
export type ISubscriptionTransaction = z.infer<typeof SubscriptionCreditTransaction>;
export type IGenericCreditAddTransaction = z.infer<typeof GenericCreditAddTransaction>;
export type IGenericCreditDeductTransaction = z.infer<typeof GenericCreditDeductTransaction>;
export type ITextGenerationUsageTransaction = z.infer<typeof TextGenerationUsageTransaction>;
export type IImageGenerationUsageTransaction = z.infer<typeof ImageGenerationUsageTransaction>;
export type IImageEditUsageTransaction = z.infer<typeof ImageEditUsageTransaction>;
export type IVideoGenerationUsageTransaction = z.infer<typeof VideoGenerationUsageTransaction>;
export type IRealtimeVoiceUsageTransaction = z.infer<typeof RealtimeVoiceUsageTransaction>;
export type IToolUsageTransaction = z.infer<typeof ToolUsageTransaction>;
export type ICompletionApiUsageTransaction = z.infer<typeof CompletionApiUsageTransaction>;
export type ISpeechToTextUsageTransaction = z.infer<typeof SpeechToTextUsageTransaction>;
export type ITextToSpeechUsageTransaction = z.infer<typeof TextToSpeechUsageTransaction>;
export type ITransferCreditTransaction = z.infer<typeof TransferCreditTransaction>;
export type IReceivedCreditTransaction = z.infer<typeof ReceivedCreditTransaction>;

/**
 * Transaction type union
 */
export type CreditTransactionType = ICreditTransaction['type'];

/**
 * Transaction types that add credits
 */
export const CREDIT_ADD_TRANSACTION_TYPES: CreditTransactionType[] = [
  'purchase',
  'subscription',
  'generic_add',
  'received_credit',
] as const;

/**
 * Transaction types that deduct credits
 */
export const CREDIT_DEDUCT_TRANSACTION_TYPES: CreditTransactionType[] = [
  'text_generation_usage',
  'image_generation_usage',
  'image_edit_usage',
  'video_generation_usage',
  'realtime_voice_usage',
  'tool_usage',
  'completion_api_usage',
  'speech_to_text_usage',
  'text_to_speech_usage',
  'transfer_credit',
  'generic_deduct',
] as const;

/** Deduct types that move credits without being a model call. */
const NON_AI_DEDUCT_TRANSACTION_TYPES: CreditTransactionType[] = ['transfer_credit', 'generic_deduct'];

/**
 * The subset of deduct types that represent AI spend, i.e. what a usage
 * breakdown should count. Derived from CREDIT_DEDUCT_TRANSACTION_TYPES rather
 * than listed, so a new `*_usage` type joins the by-source cut automatically:
 * only a deduct type that is *not* a model call needs adding above.
 */
export const AI_USAGE_TRANSACTION_TYPES: CreditTransactionType[] = CREDIT_DEDUCT_TRANSACTION_TYPES.filter(
  t => !NON_AI_DEDUCT_TRANSACTION_TYPES.includes(t)
);

/**
 * Bucket key for ledger rows carrying no `source`. Not a CompletionSource: it
 * is the residual, and the UI pins it last rather than ranking it against real
 * surfaces. `source` is optional on the write path, so this covers both rows
 * predating source tracking and any path that omits it.
 */
export const UNCLASSIFIED_SOURCE = 'unclassified';

/** A source bucket, or the residual for rows carrying no source. */
export type SourceUsageKey = CompletionSource | typeof UNCLASSIFIED_SOURCE;

/**
 * An owner's AI spend for one origin surface. Credits only: the ledger carries
 * no COGS, and token counts exist only on text rows, so summing them across a
 * bucket that mixes image/video/voice would undercount against `requests`.
 */
export interface ISourceUsage {
  source: SourceUsageKey;
  requests: number;
  creditsSpent: number;
}

/**
 * Credit transaction as returned by the API
 */
export interface ICreditTransactionResponse extends Omit<ICreditTransaction, 'createdAt' | 'updatedAt'> {
  createdAt: string;
  updatedAt: string;
}

/**
 * Credit transaction document with MongoDB properties
 */
export type ICreditTransactionDocument = ICreditTransaction & IMongoDocument;

/**
 * Filters for one page of the admin transaction ledger. Every filter is
 * optional except the page window; all narrow the same
 * {ownerId, ownerType, createdAt} index scan.
 */
export interface ILedgerQueryOptions {
  /** Trailing window in days (mutually exclusive with an explicit range; days wins if both set). */
  days?: number;
  transactionTypes?: CreditTransactionType[];
  source?: CompletionSource;
  /** Exact model id match. */
  model?: string;
  limit: number;
  skip: number;
}

/** One page of ledger documents plus the total matching count for pagination. */
export interface ILedgerPage {
  data: ICreditTransactionDocument[];
  total: number;
}

/**
 * One API key's usage rolled up from the ledger (completion_api_usage rows,
 * which carry `apiKeyId`). Credits are the spend magnitude (positive). The
 * ledger has no COGS, so this cut carries tokens + credits only, not cogsUsd.
 */
export interface IApiKeyUsage {
  apiKeyId: string;
  requests: number;
  creditsSpent: number;
  inputTokens: number;
  outputTokens: number;
}

/** API key usage with the key id resolved to its name/prefix by the API. */
export type NamedApiKeyUsage = IApiKeyUsage & { keyName?: string; keyPrefix?: string };

/**
 * A ledger row shaped for the admin UI: the transaction fields the table needs
 * plus the acting member resolved to a display name. `actingUserId` is only
 * present on API/CLI org-billed rows (metadata.actingUserId); web org-billed
 * usage does not record the member on the transaction.
 */
export interface ILedgerRow {
  id: string;
  createdAt: string; // ISO
  type: CreditTransactionType;
  credits: number;
  source?: CompletionSource;
  model?: string;
  questId?: string;
  sessionId?: string;
  apiKeyId?: string;
  description?: string;
  actingUserId?: string;
  actingUserName?: string;
}

/** Wire shape of GET /api/admin/transactions. */
export interface IAdminLedgerResponse {
  organizationId: string;
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  rows: ILedgerRow[];
}

/**
 * Credit transaction repository interface
 */
export interface ICreditTransactionRepository extends IBaseRepository<ICreditTransactionDocument> {
  createTransaction<T extends ICreditTransaction['type']>(
    type: T,
    data: Omit<Extract<ICreditTransaction, { type: T }>, 'type' | 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ICreditTransactionDocument | null>;

  findByUserId(userId: string, limit?: number): Promise<ICreditTransactionDocument[]>;
  findByPaymentIntentId(paymentIntentId: string): Promise<ICreditTransactionDocument | null>;
  updateTransactionStatus(
    paymentIntentId: string,
    status: CreditPurchaseStatus
  ): Promise<ICreditTransactionDocument | null>;
  findByOwnerWithFilters(
    ownerId: string,
    ownerType: CreditHolderType,
    options: {
      days?: number;
      transactionTypes?: CreditTransactionType[];
    }
  ): Promise<ICreditTransactionDocument[]>;

  /** One filtered, paginated page of an owner's ledger, newest first, with a total count. */
  queryLedgerPage(ownerId: string, ownerType: CreditHolderType, options: ILedgerQueryOptions): Promise<ILedgerPage>;

  /**
   * An owner's API-token spend over the trailing N days (default 30) grouped by
   * apiKeyId, from completion_api_usage ledger rows. Owner-scoped over the
   * {ownerId, ownerType, createdAt} index; biggest spender first.
   */
  apiKeyUsageForOwner(ownerId: string, ownerType: CreditHolderType, days?: number): Promise<IApiKeyUsage[]>;

  /**
   * An owner's AI spend over the trailing N days (default 30) grouped by the
   * surface it originated from, from AI_USAGE_TRANSACTION_TYPES ledger rows.
   * Rows carrying no `source` land in an `unclassified` bucket, which sorts
   * last so the buckets still sum to the owner's ledger spend.
   */
  sourceUsageForOwner(ownerId: string, ownerType: CreditHolderType, days?: number): Promise<ISourceUsage[]>;
}
