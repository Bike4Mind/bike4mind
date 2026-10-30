import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  CreditPurchaseStatus,
  CreditHolderType,
  ICreditTransaction,
  IMongoDocument,
  ICreditTransactionRepository,
  IApiKeyUsage,
  ISourceUsage,
  ILedgerPage,
  ILedgerQueryOptions,
  COMPLETION_SOURCES,
  AI_USAGE_TRANSACTION_TYPES,
  UNCLASSIFIED_SOURCE,
  CREDIT_ADD_TRANSACTION_TYPES,
  type CreditTransactionType,
} from '@bike4mind/common';

export type ICreditTransactionDocument = ICreditTransaction & IMongoDocument;

/** Transaction types that move a balance other than by usage; see the partial index below. */
export const CREDIT_BALANCE_EVENT_TYPES = [
  'purchase',
  'subscription',
  'generic_add',
  'generic_deduct',
  'transfer_credit',
  'received_credit',
] as const;

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
        'decision_usage',
        'speech_to_text_usage',
        'text_to_speech_usage',
        'sound_effects_usage',
        'music_generation_usage',
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
// Carries the _id tiebreak so findLedgerPage's keyset sort walks the index instead of sorting in memory.
// Built, and the old { ownerId, ownerType, createdAt } index dropped, by the
// 20260921235957_replace-credit-transaction-owner-index migration.
CreditTransactionSchema.index(
  { ownerId: 1, ownerType: 1, createdAt: -1, _id: -1 },
  { name: 'ownerId_ownerType_createdAt_id' }
);
// Serves the hourly young-account spend scan (CounterLogModel.ts).
// Built by CreditTransaction.createIndexes() in the 20260921235947 ensure migration.
CreditTransactionSchema.index({ ownerType: 1, createdAt: -1, type: 1 });
CreditTransactionSchema.index({ stripeDisputeId: 1 }, { unique: true, sparse: true });
// Serves the admin user timeline's credit events (userTimeline.ts). Partial on the non-usage types so a
// page never walks a heavy user's usage rows; a query must repeat the same `type: { $in }` to use it.
// Built by the 20260921235947 ensure migration.
CreditTransactionSchema.index(
  { ownerId: 1, ownerType: 1, createdAt: -1, _id: -1 },
  {
    name: 'credit_tx_owner_balance_events',
    partialFilterExpression: { type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
  }
);
CreditTransactionSchema.index({ stripeRefundId: 1 }, { unique: true, sparse: true });
CreditTransactionSchema.index({ transactionId: 1 }, { unique: true, sparse: true });

export type ICreditTransactionModel = Model<ICreditTransactionDocument>;

/**
 * Admin adjustments are the generic_add / generic_deduct rows adminUpdateUser writes with reason
 * `admin_adjustment` against a User holder. Shared by the admin ledger page and the per-user credit
 * chart so the two can never disagree about what counts as an adjustment.
 */
const ADMIN_ADJUSTMENT_FILTER = {
  ownerType: CreditHolderType.User,
  type: { $in: ['generic_add', 'generic_deduct'] },
  reason: 'admin_adjustment',
};

/** Position of one ledger row in the {createdAt, _id} newest-first order. */
export type LedgerCursorPosition = { createdAt: Date; id: string };

/** Narrows findLedgerPage; every set field must match. */
export type LedgerPageFilter = {
  types?: CreditTransactionType[];
  model?: string;
  source?: string;
  /** Inclusive lower bound on createdAt. */
  createdFrom?: Date;
  /** Exclusive upper bound on createdAt. */
  createdBefore?: Date;
};

/** AI spend of one model or source over the trailing 7, 30 and 90 UTC days including today. */
export type AiSpendBucket = { key: string | null; last7d: number; last30d: number; last90d: number };

export type AiSpendSummary = {
  spent: { last24h: number; last7d: number; last30d: number };
  topModel30d: { model: string; credits: number } | null;
  /** Spend per UTC day with activity, 'YYYY-MM-DD' ascending; days with no spend are absent. */
  dailyCredits: Array<{ day: string; credits: number }>;
  /** Largest 90-day spend first; a null key collects rows that recorded no model. */
  byModel: AiSpendBucket[];
  /** Largest 90-day spend first; a null key collects rows that recorded no source. */
  bySource: AiSpendBucket[];
};

export const API_KEY_REQUEST_TRANSACTION_TYPES = ['completion_api_usage', 'decision_usage'];

const DAY_MS = 24 * 60 * 60 * 1000;
export const AI_SPEND_DAILY_WINDOW_DAYS = 90;

/** Rows strictly older than `position` in newest-first order (the next page after it). */
const olderThan = ({ createdAt, id }: LedgerCursorPosition) => ({
  $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: new mongoose.Types.ObjectId(id) } }],
});

/** Rows strictly newer than `position` in newest-first order. */
const newerThan = ({ createdAt, id }: LedgerCursorPosition) => ({
  $or: [{ createdAt: { $gt: createdAt } }, { createdAt, _id: { $gt: new mongoose.Types.ObjectId(id) } }],
});

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
      limit?: number;
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

    let cursor = this.model.find(query).sort({ createdAt: -1 });
    if (options.limit !== undefined) {
      cursor = cursor.limit(options.limit);
    }
    return cursor.exec();
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
    // together since a busy org can have tens of thousands of rows. Not a single
    // transaction: a concurrent write between the two can make total differ from
    // the page by one - acceptable for a read-only admin view.
    const [data, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(options.skip).limit(options.limit).exec(),
      this.model.countDocuments(query),
    ]);

    return { data, total };
  }

  async dailyNetCreditsForOwner(
    ownerId: string,
    ownerType: CreditHolderType,
    from: Date,
    to: Date
  ): Promise<Array<{ day: string; netCredits: number }>> {
    // Rides the {ownerId, ownerType, createdAt, _id} index; usage rows are numerous, so sum server-side.
    // Bounded at both ends so the sum and the balance snapshot describe the same instant.
    const rows = await this.model.aggregate<{ _id: string; netCredits: number }>([
      { $match: { ownerId, ownerType, createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          netCredits: { $sum: '$credits' },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    return rows.map(({ _id, netCredits }) => ({ day: _id, netCredits }));
  }

  async findAdminAdjustmentsForUser(
    userId: string,
    from: Date,
    to: Date,
    limit: number
  ): Promise<ICreditTransactionDocument[]> {
    return this.model
      .find({ ...ADMIN_ADJUSTMENT_FILTER, ownerId: userId, createdAt: { $gte: from, $lte: to } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  async queryAdminAdjustmentsPage(options: { days?: number; limit: number; skip: number }): Promise<ILedgerPage> {
    const query: Record<string, unknown> = { ...ADMIN_ADJUSTMENT_FILTER };

    if (options.days !== undefined) {
      const from = new Date();
      from.setDate(from.getDate() - options.days);
      query.createdAt = { $gte: from };
    }

    const [data, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(options.skip).limit(options.limit).exec(),
      this.model.countDocuments(query),
    ]);

    return { data, total };
  }

  /**
   * One keyset page of an owner's ledger, newest first by {createdAt, _id}. Pass the last row of the
   * previous page as `after` to continue strictly past it. Rides the {ownerId, ownerType, createdAt, _id}
   * index; the _id tiebreak keeps rows sharing a timestamp from being skipped or repeated.
   */
  async findLedgerPage(
    ownerId: string,
    ownerType: CreditHolderType,
    options: LedgerPageFilter & { after?: LedgerCursorPosition; limit: number }
  ): Promise<ICreditTransactionDocument[]> {
    const query: Record<string, unknown> = { ownerId, ownerType };
    if (options.types && options.types.length > 0) query.type = { $in: options.types };
    // model and source are residual filters on the owner index: an admin view of one user, so the scan is
    // bounded by that user's ledger.
    if (options.model) query.model = options.model;
    if (options.source) query.source = options.source;
    const createdAt: Record<string, Date> = {};
    if (options.createdFrom) createdAt.$gte = options.createdFrom;
    if (options.createdBefore) createdAt.$lt = options.createdBefore;
    if (Object.keys(createdAt).length > 0) query.createdAt = createdAt;
    // The cursor's own createdAt terms sit inside $or, so they AND with the range above.
    if (options.after) Object.assign(query, olderThan(options.after));
    return this.model.find(query).sort({ createdAt: -1, _id: -1 }).limit(options.limit).exec();
  }

  /**
   * Net signed credits of every row of this owner strictly newer than `position`: the amount the
   * balance moved after that row, so `balance - result` is the balance right after it. Signs follow
   * the transaction type (add types positive, all others negative) because writers disagree on the
   * sign of stored deduct rows.
   */
  async sumSignedCreditsNewerThan(
    ownerId: string,
    ownerType: CreditHolderType,
    position: LedgerCursorPosition
  ): Promise<number> {
    const [row] = await this.model.aggregate<{ total: number }>([
      { $match: { ownerId, ownerType, ...newerThan(position) } },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $in: ['$type', [...CREDIT_ADD_TRANSACTION_TYPES]] },
                { $abs: '$credits' },
                { $multiply: [-1, { $abs: '$credits' }] },
              ],
            },
          },
        },
      },
    ]);
    return row?.total ?? 0;
  }

  /** AI spend (magnitudes) over rolling 24h/7d/30d windows, the 30-day top model and per-UTC-day sums. */
  async summarizeAiSpend(ownerId: string, ownerType: CreditHolderType, now: Date): Promise<AiSpendSummary> {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dailyFrom = new Date(dayStart.getTime() - (AI_SPEND_DAILY_WINDOW_DAYS - 1) * DAY_MS);
    const from24h = new Date(now.getTime() - DAY_MS);
    const from7d = new Date(now.getTime() - 7 * DAY_MS);
    const from30d = new Date(now.getTime() - 30 * DAY_MS);
    const spendWithin = (from: Date) => ({
      $sum: { $cond: [{ $gte: ['$createdAt', from] }, { $abs: '$credits' }, 0] },
    });
    // Day-aligned like `daily`, so a breakdown and the by-day chart total the same for one range.
    const fromDays = (days: number) => new Date(dayStart.getTime() - (days - 1) * DAY_MS);
    const breakdownBy = (field: '$model' | '$source') => [
      {
        $group: {
          // A missing field groups as null.
          _id: field,
          last7d: spendWithin(fromDays(7)),
          last30d: spendWithin(fromDays(30)),
          last90d: spendWithin(fromDays(AI_SPEND_DAILY_WINDOW_DAYS)),
        },
      },
      { $sort: { last90d: -1 as const, _id: 1 as const } },
    ];

    const [result] = await this.model.aggregate<{
      totals: Array<{ last24h: number; last7d: number; last30d: number }>;
      byModel: Array<{ _id: string; credits: number }>;
      daily: Array<{ _id: string; credits: number }>;
      byModel90d: Array<{ _id: string | null; last7d: number; last30d: number; last90d: number }>;
      bySource90d: Array<{ _id: string | null; last7d: number; last30d: number; last90d: number }>;
    }>([
      {
        $match: {
          ownerId,
          ownerType,
          type: { $in: [...AI_USAGE_TRANSACTION_TYPES] },
          createdAt: { $gte: dailyFrom, $lte: now },
        },
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                last24h: spendWithin(from24h),
                last7d: spendWithin(from7d),
                last30d: spendWithin(from30d),
              },
            },
          ],
          byModel: [
            { $match: { createdAt: { $gte: from30d }, model: { $type: 'string' } } },
            { $group: { _id: '$model', credits: { $sum: { $abs: '$credits' } } } },
            { $sort: { credits: -1, _id: 1 } },
            { $limit: 1 },
          ],
          daily: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
                credits: { $sum: { $abs: '$credits' } },
              },
            },
            { $sort: { _id: 1 } },
          ],
          byModel90d: breakdownBy('$model'),
          bySource90d: breakdownBy('$source'),
        },
      },
    ]);
    const toBuckets = (rows: Array<{ _id: string | null; last7d: number; last30d: number; last90d: number }> = []) =>
      rows.map(({ _id, last7d, last30d, last90d }) => ({ key: _id, last7d, last30d, last90d }));

    const totals = result?.totals[0];
    const top = result?.byModel[0];
    return {
      spent: { last24h: totals?.last24h ?? 0, last7d: totals?.last7d ?? 0, last30d: totals?.last30d ?? 0 },
      topModel30d: top ? { model: top._id, credits: top.credits } : null,
      dailyCredits: (result?.daily ?? []).map(({ _id, credits }) => ({ day: _id, credits })),
      byModel: toBuckets(result?.byModel90d),
      bySource: toBuckets(result?.bySource90d),
    };
  }

  /** Newest completed purchase or subscription grant: the owner's last top-up, or null. */
  async findLatestTopUp(ownerId: string, ownerType: CreditHolderType): Promise<ICreditTransactionDocument | null> {
    return this.model
      .findOne({
        ownerId,
        ownerType,
        type: { $in: ['purchase', 'subscription'] },
        // Only purchases carry a status; a pending or failed one granted nothing.
        $or: [{ status: 'completed' }, { status: { $exists: false } }, { status: null }],
      })
      .sort({ createdAt: -1, _id: -1 })
      .exec();
  }

  async apiKeyUsageForOwner(ownerId: string, ownerType: CreditHolderType, days: number = 30): Promise<IApiKeyUsage[]> {
    const from = new Date();
    from.setDate(from.getDate() - days);
    return this.model.aggregate<IApiKeyUsage>([
      { $match: { ownerId, ownerType, createdAt: { $gte: from }, apiKeyId: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$apiKeyId',
          // Chat, tool, media and agent rows also carry the key (for per-key spend), but one request
          // can write several of them; only these types are one row per API request.
          requests: { $sum: { $cond: [{ $in: ['$type', API_KEY_REQUEST_TRANSACTION_TYPES] }, 1, 0] } },
          // Usage is stored negative; report the spend magnitude.
          creditsSpent: { $sum: { $abs: '$credits' } },
          inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
        },
      },
      { $project: { _id: 0, apiKeyId: '$_id', requests: 1, creditsSpent: 1, inputTokens: 1, outputTokens: 1 } },
      { $sort: { creditsSpent: -1 } },
    ]);
  }

  async sourceUsageForOwner(ownerId: string, ownerType: CreditHolderType, days: number = 30): Promise<ISourceUsage[]> {
    const from = new Date();
    from.setDate(from.getDate() - days);
    return this.model.aggregate<ISourceUsage>([
      // Filter by type rather than by `source` existence: purchases and refunds
      // carry no source, but so do pre-tracking usage rows, and those must still
      // be counted or the buckets stop summing to the owner's ledger spend.
      {
        $match: {
          ownerId,
          ownerType,
          createdAt: { $gte: from },
          type: { $in: [...AI_USAGE_TRANSACTION_TYPES] },
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$source', UNCLASSIFIED_SOURCE] },
          requests: { $sum: 1 },
          // Usage is stored negative; report the spend magnitude.
          creditsSpent: { $sum: { $abs: '$credits' } },
        },
      },
      {
        $project: {
          _id: 0,
          source: '$_id',
          requests: 1,
          creditsSpent: 1,
          residual: { $cond: [{ $eq: ['$_id', UNCLASSIFIED_SOURCE] }, 1, 0] },
        },
      },
      // Unclassified is a residual, not a peer surface: keep it last whatever it
      // spent. `source` breaks ties so equal-spend buckets don't swap places
      // between identical requests.
      { $sort: { residual: 1, creditsSpent: -1, source: 1 } },
      { $unset: 'residual' },
    ]);
  }
}

export const CreditTransaction =
  (mongoose.models['CreditTransaction'] as unknown as ICreditTransactionModel) ??
  model<ICreditTransactionDocument>('CreditTransaction', CreditTransactionSchema);
export const creditTransactionRepository = new CreditTransactionRepository(CreditTransaction);
