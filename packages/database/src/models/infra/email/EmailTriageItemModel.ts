import mongoose, { Schema } from 'mongoose';
import { BRIEF_LIMITS, type BriefDraftReply } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import { lockRetentionCreator } from '../../../utils/organizationRetention';
import { IngestedEmailModel } from './IngestedEmailModel';

export const EMAIL_TRIAGE_KINDS = ['decision', 'handled', 'fyi'] as const;
export type EmailTriageKind = (typeof EMAIL_TRIAGE_KINDS)[number];

/**
 * The triage outcome for one ingested email, written by apps/workers/src/emailIngestion/emailTriage.ts and
 * folded into the owner's next assistant brief. At most one per email: `emailId` is unique.
 */
export type IEmailTriageItem = {
  _id: mongoose.Types.ObjectId;
  userId: string;
  emailId: string;
  kind: EmailTriageKind;
  summary: string;
  draftReply?: BriefDraftReply;
  model: string | null;
  tokensUsed: number | null;
  /** When a ready brief carried this item; null until then, so an item a brief's caps left out stays pending. */
  briefedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EmailTriageItemInput = Omit<IEmailTriageItem, '_id' | 'briefedAt' | 'createdAt' | 'updatedAt'>;

type LiveEmailTriageResult = { status: 'created' } | { status: 'duplicate' } | { status: 'unavailable' };

const schema = new Schema<IEmailTriageItem>(
  {
    userId: { type: String, required: true },
    emailId: { type: String, required: true, unique: true },
    kind: { type: String, enum: EMAIL_TRIAGE_KINDS, required: true },
    summary: { type: String, required: true, maxlength: BRIEF_LIMITS.itemText },
    draftReply: {
      type: new Schema(
        {
          to: { type: String, required: true, maxlength: BRIEF_LIMITS.draftTo },
          subject: { type: String, required: true, maxlength: BRIEF_LIMITS.draftSubject },
          body: { type: String, required: true, maxlength: BRIEF_LIMITS.draftBody },
        },
        { _id: false }
      ),
      required: false,
    },
    model: { type: String, default: null },
    tokensUsed: { type: Number, default: null },
    briefedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'EmailTriageItem' }
);

schema.index({ userId: 1, briefedAt: 1, createdAt: 1 });
schema.index({ userId: 1, briefedAt: 1, kind: 1, createdAt: 1 });

export const EmailTriageItemModel =
  (mongoose.models.EmailTriageItem as mongoose.Model<IEmailTriageItem> | undefined) ??
  mongoose.model<IEmailTriageItem>('EmailTriageItem', schema);

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

export const emailTriageItemRepository = {
  /** Admit derived content only while both its owner and source email are live. No model work runs here. */
  async storeForLiveEmail(input: EmailTriageItemInput): Promise<LiveEmailTriageResult> {
    try {
      return await withTransaction<LiveEmailTriageResult>(async session => {
        if (!(await lockRetentionCreator(input.userId, session))) return { status: 'unavailable' };
        // A real source write serializes with soft deletion; a pre-read would still admit a late insert.
        const source = await IngestedEmailModel.updateOne(
          { _id: input.emailId, userId: input.userId, deletedAt: null },
          { $inc: { __v: 1 } },
          { session, timestamps: false, maxTimeMS: 15_000, runValidators: true }
        );
        if (!source.acknowledged) throw new Error('Email admission write was not acknowledged');
        if (source.matchedCount !== 1 || source.modifiedCount !== 1) return { status: 'unavailable' };
        const stored = await EmailTriageItemModel.updateOne(
          { emailId: input.emailId },
          { $setOnInsert: input },
          { session, upsert: true, runValidators: true, maxTimeMS: 15_000 }
        );
        if (!stored.acknowledged) throw new Error('Email triage insert was not acknowledged');
        return { status: stored.upsertedCount === 1 ? 'created' : 'duplicate' };
      });
    } catch (error) {
      // A duplicate can abort the transaction. Handle it only after the transaction has unwound.
      if (isDuplicateKeyError(error)) return { status: 'duplicate' };
      throw error;
    }
  },

  /** Insert-only: a re-analyzed email keeps its first triage. `created` is false when one already existed. */
  async upsertForEmail(input: EmailTriageItemInput): Promise<{ created: boolean }> {
    try {
      // updateOne skips validators by default; the insert must still honor the enum and summary cap.
      const result = await EmailTriageItemModel.updateOne(
        { emailId: input.emailId },
        { $setOnInsert: input },
        { upsert: true, runValidators: true }
      );
      return { created: result.upsertedCount === 1 };
    } catch (error) {
      // Two concurrent upserts can both miss the filter; the unique index rejects the second insert.
      if (isDuplicateKeyError(error)) return { created: false };
      throw error;
    }
  },

  async existsForEmail(emailId: string): Promise<boolean> {
    return (await EmailTriageItemModel.exists({ emailId })) !== null;
  },

  /** Items no ready brief has carried yet, created before `end` and at or after `since` when given, oldest first. */
  async listPending(
    userId: string,
    end: Date,
    limit: number,
    kind?: EmailTriageKind,
    since?: Date
  ): Promise<IEmailTriageItem[]> {
    const createdAt = since ? { $gte: since, $lt: end } : { $lt: end };
    return EmailTriageItemModel.find({ userId, briefedAt: null, createdAt, ...(kind && { kind }) })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  },

  async markBriefed(userId: string, emailIds: string[], at: Date): Promise<number> {
    if (emailIds.length === 0) return 0;
    const result = await EmailTriageItemModel.updateMany(
      { userId, emailId: { $in: emailIds }, briefedAt: null },
      { $set: { briefedAt: at } },
      { runValidators: true }
    );
    return result.modifiedCount;
  },

  /** The subset of `emailIds` that still has a triage item (one deleted with its email has none). */
  async storedEmailIds(userId: string, emailIds: string[]): Promise<string[]> {
    if (emailIds.length === 0) return [];
    return EmailTriageItemModel.distinct('emailId', { userId, emailId: { $in: emailIds } });
  },

  async deleteByEmailIds(userId: string, emailIds: string[]): Promise<number> {
    const result = await EmailTriageItemModel.deleteMany({ userId, emailId: { $in: emailIds } });
    return result.deletedCount;
  },
};
