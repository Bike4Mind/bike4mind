import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { CreditHolderType } from './CreditHolderTypes';
import { COMPLETION_SOURCES } from '../analytics';

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
  'transfer_credit',
  'generic_deduct',
] as const;

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
}
