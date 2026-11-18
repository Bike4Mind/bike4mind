import mongoose, { Schema } from 'mongoose';
import type { BriefDraftReply } from '@bike4mind/common';

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
  createdAt: Date;
  updatedAt: Date;
};

export type EmailTriageItemInput = Omit<IEmailTriageItem, '_id' | 'createdAt' | 'updatedAt'>;

const schema = new Schema<IEmailTriageItem>(
  {
    userId: { type: String, required: true },
    emailId: { type: String, required: true, unique: true },
    kind: { type: String, enum: EMAIL_TRIAGE_KINDS, required: true },
    summary: { type: String, required: true, maxlength: 400 },
    draftReply: {
      type: new Schema(
        {
          to: { type: String, required: true },
          subject: { type: String, required: true },
          body: { type: String, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    model: { type: String, default: null },
    tokensUsed: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false, collection: 'EmailTriageItem' }
);

schema.index({ userId: 1, createdAt: -1 });

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

  /** Items created in [start, end), oldest first. */
  async listForWindow(userId: string, start: Date, end: Date, limit: number): Promise<IEmailTriageItem[]> {
    return EmailTriageItemModel.find({ userId, createdAt: { $gte: start, $lt: end } })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();
  },

  async deleteByEmailIds(userId: string, emailIds: string[]): Promise<number> {
    const result = await EmailTriageItemModel.deleteMany({ userId, emailId: { $in: emailIds } });
    return result.deletedCount;
  },
};
