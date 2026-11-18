import mongoose, { Schema } from 'mongoose';
import { BRIEF_LIMITS, type BriefDraftReply } from '@bike4mind/common';

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

export const EmailTriageItemModel =
  (mongoose.models.EmailTriageItem as mongoose.Model<IEmailTriageItem> | undefined) ??
  mongoose.model<IEmailTriageItem>('EmailTriageItem', schema);

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

export const emailTriageItemRepository = {
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

  /** Items no ready brief has carried yet, created before `end`, oldest first. */
  async listPending(userId: string, end: Date, limit: number): Promise<IEmailTriageItem[]> {
    return EmailTriageItemModel.find({ userId, briefedAt: null, createdAt: { $lt: end } })
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
