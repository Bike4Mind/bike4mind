import mongoose, { Model, model, Schema, Types } from 'mongoose';
import {
  ConflictError,
  type AccessReviewDecision,
  type AccessReviewReviewer,
  type AdminAccessReviewRecord,
  type IAdminAccessReviewRepository,
} from '@bike4mind/common';

/** One quarterly access review per quarter, with a keep/revoke decision per admin account. */

const DUPLICATE_KEY_ERROR_CODE = 11000;

type AdminAccessReviewDocumentShape = {
  _id: Types.ObjectId;
  quarter: string;
  dormantDays: number;
  startedAt: Date;
  startedBy: AccessReviewReviewer;
  decisions: AccessReviewDecision[];
  completedAt: Date | null;
  completedBy: AccessReviewReviewer | null;
};

const ReviewerSchema = new Schema(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true },
  },
  { _id: false }
);

const DecisionSchema = new Schema(
  {
    userId: { type: String, required: true },
    email: { type: String, default: null },
    fullAdmin: { type: Boolean, required: true },
    permissions: { type: [String], default: [] },
    decision: { type: String, enum: ['confirmed', 'revoked'], required: true },
    reviewer: { type: ReviewerSchema, required: true },
    decidedAt: { type: Date, required: true },
    auditEntryId: { type: String },
  },
  { _id: false }
);

const AdminAccessReviewSchema = new Schema<AdminAccessReviewDocumentShape>(
  {
    // The unique index is what keeps two concurrent first decisions to one record.
    quarter: { type: String, required: true, unique: true },
    dormantDays: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    startedBy: { type: ReviewerSchema, required: true },
    decisions: { type: [DecisionSchema], default: [] },
    completedAt: { type: Date, default: null },
    completedBy: { type: ReviewerSchema, default: null },
  },
  { collection: 'adminaccessreviews', timestamps: false, versionKey: false }
);

AdminAccessReviewSchema.index({ completedAt: -1 });

export const AdminAccessReviewModel: Model<AdminAccessReviewDocumentShape> =
  (mongoose.models.AdminAccessReview as Model<AdminAccessReviewDocumentShape> | undefined) ??
  model<AdminAccessReviewDocumentShape>('AdminAccessReview', AdminAccessReviewSchema);

const toReviewer = (reviewer: AccessReviewReviewer): AccessReviewReviewer => ({
  userId: reviewer.userId,
  name: reviewer.name,
});

const toDecision = (decision: AccessReviewDecision): AccessReviewDecision => ({
  userId: decision.userId,
  email: decision.email ?? null,
  fullAdmin: decision.fullAdmin,
  permissions: [...(decision.permissions ?? [])],
  decision: decision.decision,
  reviewer: toReviewer(decision.reviewer),
  decidedAt: decision.decidedAt,
  ...(decision.auditEntryId ? { auditEntryId: decision.auditEntryId } : {}),
});

export const toAdminAccessReviewRecord = (document: AdminAccessReviewDocumentShape): AdminAccessReviewRecord => ({
  id: String(document._id),
  quarter: document.quarter,
  dormantDays: document.dormantDays,
  startedAt: document.startedAt,
  startedBy: toReviewer(document.startedBy),
  decisions: (document.decisions ?? []).map(toDecision),
  completedAt: document.completedAt ?? null,
  completedBy: document.completedBy ? toReviewer(document.completedBy) : null,
});

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR_CODE;

class AdminAccessReviewRepository implements IAdminAccessReviewRepository {
  constructor(private readonly reviewModel: Model<AdminAccessReviewDocumentShape>) {}

  async findByQuarter(quarter: string): Promise<AdminAccessReviewRecord | null> {
    const document = await this.reviewModel.findOne({ quarter }).lean<AdminAccessReviewDocumentShape>();
    return document ? toAdminAccessReviewRecord(document) : null;
  }

  async findLatestCompleted(): Promise<AdminAccessReviewRecord | null> {
    const document = await this.reviewModel
      .findOne({ completedAt: { $ne: null } })
      .sort({ completedAt: -1 })
      .lean<AdminAccessReviewDocumentShape>();
    return document ? toAdminAccessReviewRecord(document) : null;
  }

  async recordDecision(
    quarter: string,
    dormantDays: number,
    startedBy: AccessReviewReviewer,
    decision: AccessReviewDecision
  ): Promise<AdminAccessReviewRecord> {
    await this.ensureRecord(quarter, dormantDays, startedBy);
    const entry = toDecision(decision);

    // Two passes: a concurrent confirm can land between a missed confirm->revoke and the guarded push.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (entry.decision === 'revoked') {
        const replaced = await this.reviewModel
          .findOneAndUpdate(
            { quarter, decisions: { $elemMatch: { userId: entry.userId, decision: 'confirmed' } } },
            { $set: { 'decisions.$': entry } },
            { new: true }
          )
          .lean<AdminAccessReviewDocumentShape>();
        if (replaced) return toAdminAccessReviewRecord(replaced);
      }

      const pushed = await this.reviewModel
        .findOneAndUpdate(
          { quarter, 'decisions.userId': { $ne: entry.userId } },
          { $push: { decisions: entry } },
          { new: true }
        )
        .lean<AdminAccessReviewDocumentShape>();
      if (pushed) return toAdminAccessReviewRecord(pushed);

      const current = await this.findByQuarter(quarter);
      const existing = current?.decisions.find(({ userId }) => userId === entry.userId);
      if (!current || !existing) throw new Error(`Access review ${quarter} lost a decision write`);
      if (existing.decision === entry.decision) return current;
      if (existing.decision === 'revoked') {
        throw new ConflictError('This admin access was already revoked in this review');
      }
    }
    throw new ConflictError('This admin access decision changed concurrently; reload and try again');
  }

  async markCompleted(quarter: string, at: Date, by: AccessReviewReviewer): Promise<AdminAccessReviewRecord | null> {
    await this.reviewModel.updateOne(
      { quarter, completedAt: null },
      { $set: { completedAt: at, completedBy: toReviewer(by) } }
    );
    return this.findByQuarter(quarter);
  }

  private async ensureRecord(quarter: string, dormantDays: number, startedBy: AccessReviewReviewer): Promise<void> {
    const upsert = () =>
      this.reviewModel.updateOne(
        { quarter },
        {
          $setOnInsert: {
            quarter,
            dormantDays,
            startedAt: new Date(),
            startedBy: toReviewer(startedBy),
            decisions: [],
            completedAt: null,
            completedBy: null,
          },
        },
        { upsert: true }
      );
    try {
      await upsert();
    } catch (error) {
      // Two concurrent upserts can both miss and race the insert; the loser now finds the winner's record.
      if (!isDuplicateKeyError(error)) throw error;
      await upsert();
    }
  }
}

export const adminAccessReviewRepository: IAdminAccessReviewRepository = new AdminAccessReviewRepository(
  AdminAccessReviewModel
);
