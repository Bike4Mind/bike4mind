import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  CreditPurchaseStatus,
  CreditHolderType,
  ICreditTransaction,
  IMongoDocument,
  ICreditTransactionRepository,
  ILedgerPage,
  ILedgerQueryOptions,
  COMPLETION_SOURCES,
} from '@bike4mind/common';

export type ICreditTransactionDocument = ICreditTransaction & IMongoDocument;

/**
 * IMPORTANT: When adding a new transaction type, you MUST update:
 * 1. b4m-core/common/src/types/entities/CreditTransactionTypes.ts - Create new schema and add to discriminated union
 * 2. This file - Add to the `type` enum below AND add any new fields to the schema
 * 3. b4m-core/services/src/creditService/subtractCredits.ts - Add handler in switch statement
 * 4. apps/client/app/components/ProfileModal/CreditAnalyticsTabContent.tsx - Add filtering and display logic
 *
 * The enum below MUST match the transaction types defined in CreditTransactionTypes.ts
 */
const CreditTransactionSchema = new Schema<ICreditTransactionDocument>(
  {
    ownerId: { type: String, required: true },
    ownerType: { type: String, required: true, enum: ['User', 'Organization', 'Agent'] as CreditHolderType[] },
    credits: { type: Number, required: true },
    description: { type: String, required: false },
    metadata: { type: Schema.Types.Mixed, required: false },
    type: {
      type: String,
      required: true,
      enum: [
        'purchase',
        'subscription',
        'generic_add',
        'generic_deduct',
        'text_generation_usage',
        'image_generation_usage',
        'image_edit_usage',
        'video_generation_usage',
        'realtime_voice_usage',
        'tool_usage',
        'completion_api_usage',
        'speech_to_text_usage',
        'transfer_credit',
        'received_credit',
      ],
    },

    // Purchase transaction fields (optional in schema, required by TypeScript for purchase type)
    amount: { type: Number, required: false },
    status: {
      type: String,
      required: false,
      enum: ['completed', 'pending', 'failed'] as CreditPurchaseStatus[],
    },
    stripePaymentIntentId: { type: String, required: false },
    packageId: { type: String, required: false },

    // Usage transaction fields
    model: { type: String, required: false },
    questId: { type: String, required: false },
    sessionId: { type: String, required: false },
    inputTokens: { type: Number, required: false },
    outputTokens: { type: Number, required: false },
    apiKeyId: { type: String, required: false }, // For completion_api_usage (optional - present for API key auth, undefined for JWT)

    // Transfer and received credit fields
    recipientId: { type: String, required: false },
    recipientType: { type: String, required: false },
    senderId: { type: String, required: false },
    senderType: { type: String, required: false },

    // Generic fields
    reason: { type: String, required: false },

    // Dispute/refund clawback fields (generic_deduct transactions)
    stripeDisputeId: { type: String, required: false },
    stripeRefundId: { type: String, required: false },

    // Idempotency key for generic_add refund transactions (e.g. Qwork credit settlements)
    transactionId: { type: String, required: false },

    // Where the transaction originated (web/cli/api/agent/system). Optional -
    // historical rows are unclassified, and non-usage transactions (purchases,
    // refunds, transfers) don't carry meaningful source.
    source: { type: String, required: false, enum: [...COMPLETION_SOURCES] },

    /**
     * @deprecated Use ownerId and ownerType instead
     */
    userId: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Indexes for faster queries
CreditTransactionSchema.index({ userId: 1, createdAt: -1 });
CreditTransactionSchema.index({ stripePaymentIntentId: 1 }, { unique: true, sparse: true });
CreditTransactionSchema.index({ ownerId: 1, ownerType: 1, createdAt: -1 });
CreditTransactionSchema.index({ stripeDisputeId: 1 }, { unique: true, sparse: true });
CreditTransactionSchema.index({ stripeRefundId: 1 }, { unique: true, sparse: true });
CreditTransactionSchema.index({ transactionId: 1 }, { unique: true, sparse: true });

export type ICreditTransactionModel = Model<ICreditTransactionDocument>;

export class CreditTransactionRepository
  extends BaseRepository<ICreditTransactionDocument>
  implements ICreditTransactionRepository
{
  constructor(model: ICreditTransactionModel) {
    super(model);
  }

  async createTransaction<T extends ICreditTransaction['type']>(
    type: T,
    data: Omit<Extract<ICreditTransaction, { type: T }>, 'type' | 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ICreditTransactionDocument | null> {
    try {
      return await this.create({
        type,
        ...data,
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    } catch (err) {
      // E11000 on transactionId = idempotent duplicate (SQS retry or concurrent handler)
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code: number; keyPattern?: Record<string, number> }).code === 11000 &&
        (err as { code: number; keyPattern?: Record<string, number> }).keyPattern?.transactionId === 1
      ) {
        return null;
      }
      throw err;
    }
  }

  async findByUserId(userId: string, limit: number = 50) {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByPaymentIntentId(paymentIntentId: string) {
    return this.model.findOne({ stripePaymentIntentId: paymentIntentId });
  }

  async updateTransactionStatus(paymentIntentId: string, status: CreditPurchaseStatus) {
    return this.model.findOneAndUpdate({ stripePaymentIntentId: paymentIntentId }, { status }, { new: true });
  }

  async findByOwnerWithFilters(
    ownerId: string,
    ownerType: CreditHolderType,
    options: {
      days?: number;
      transactionTypes?: ICreditTransaction['type'][];
    }
  ) {
    const query: {
      ownerId: string;
      ownerType: CreditHolderType;
      createdAt?: { $gte: Date };
      type?: { $in: ICreditTransaction['type'][] };
    } = {
      ownerId,
      ownerType,
    };

    if (options.days !== undefined) {
      const dateThreshold = new Date();
      dateThreshold.setDate(dateThreshold.getDate() - options.days);
      query.createdAt = { $gte: dateThreshold };
    }

    if (options.transactionTypes && options.transactionTypes.length > 0) {
      query.type = { $in: options.transactionTypes };
    }

    return this.model.find(query).sort({ createdAt: -1 }).exec();
  }

  async queryLedgerPage(
    ownerId: string,
    ownerType: CreditHolderType,
    options: ILedgerQueryOptions
  ): Promise<ILedgerPage> {
    const query: Record<string, unknown> = { ownerId, ownerType };

    if (options.days !== undefined) {
      const from = new Date();
      from.setDate(from.getDate() - options.days);
      query.createdAt = { $gte: from };
    }
    if (options.transactionTypes && options.transactionTypes.length > 0) {
      query.type = { $in: options.transactionTypes };
    }
    if (options.source) {
      query.source = options.source;
    }
    if (options.model) {
      query.model = options.model;
    }

    // count + page share the {ownerId, ownerType, createdAt} index; run them
    // together since a busy org can have tens of thousands of rows.
    const [data, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(options.skip).limit(options.limit).exec(),
      this.model.countDocuments(query),
    ]);

    return { data, total };
  }
}

export const CreditTransaction =
  (mongoose.models['CreditTransaction'] as unknown as ICreditTransactionModel) ??
  model<ICreditTransactionDocument>('CreditTransaction', CreditTransactionSchema);
export const creditTransactionRepository = new CreditTransactionRepository(CreditTransaction);
