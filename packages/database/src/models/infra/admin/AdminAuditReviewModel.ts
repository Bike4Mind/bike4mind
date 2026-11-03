import mongoose, { Model, model, Schema, Types } from 'mongoose';
import type { AuditReview, IAdminAuditReviewRepository, NewAuditReview } from '@bike4mind/common';

/** Sign-offs on critical audit entries. Separate from AdminAuditLog because its entries are immutable. */

const DUPLICATE_KEY_ERROR_CODE = 11000;

type AdminAuditReviewDocumentShape = {
  _id: Types.ObjectId;
  auditEntryId: Types.ObjectId;
  reviewer: { userId: string | null; name: string };
  reviewedAt: Date;
  note?: string;
  baseline?: boolean;
};

const ReviewerSchema = new Schema(
  {
    userId: { type: String, default: null },
    name: { type: String, required: true },
  },
  { _id: false }
);

const AdminAuditReviewSchema = new Schema<AdminAuditReviewDocumentShape>(
  {
    // The unique index is what keeps a concurrent double review to one document.
    auditEntryId: { type: Schema.Types.ObjectId, required: true, unique: true },
    reviewer: { type: ReviewerSchema, required: true },
    reviewedAt: { type: Date, required: true },
    note: { type: String },
    baseline: { type: Boolean },
  },
  { collection: 'adminauditreviews', timestamps: false, versionKey: false }
);

export const AdminAuditReviewModel: Model<AdminAuditReviewDocumentShape> =
  (mongoose.models.AdminAuditReview as Model<AdminAuditReviewDocumentShape> | undefined) ??
  model<AdminAuditReviewDocumentShape>('AdminAuditReview', AdminAuditReviewSchema);

export const toAuditReview = (document: AdminAuditReviewDocumentShape): AuditReview => ({
  auditEntryId: String(document.auditEntryId),
  reviewer: { userId: document.reviewer.userId ?? null, name: document.reviewer.name },
  reviewedAt: document.reviewedAt,
  ...(document.note ? { note: document.note } : {}),
  ...(document.baseline ? { baseline: true } : {}),
});

type InsertFailure = { index: number; code: unknown };

const readInsertFailures = (error: unknown): InsertFailure[] | null => {
  if (typeof error !== 'object' || error === null || !('writeErrors' in error) || !Array.isArray(error.writeErrors)) {
    return null;
  }
  return error.writeErrors.map((writeError: unknown): InsertFailure => {
    // The driver exposes the failure directly or under `err`, depending on the path.
    const source: unknown =
      typeof writeError === 'object' && writeError !== null && 'err' in writeError ? writeError.err : writeError;
    const index = typeof source === 'object' && source !== null && 'index' in source ? source.index : undefined;
    const code = typeof source === 'object' && source !== null && 'code' in source ? source.code : undefined;
    return { index: typeof index === 'number' ? index : -1, code };
  });
};

// Entry ids reach here already checked as ObjectId hex by the route, so the casts cannot throw.
class AdminAuditReviewRepository implements IAdminAuditReviewRepository {
  constructor(private readonly reviewModel: Model<AdminAuditReviewDocumentShape>) {}

  async createMany(reviews: NewAuditReview[]): Promise<string[]> {
    if (reviews.length === 0) return [];
    const reviewedAt = new Date();
    const documents = reviews.map(review => ({
      ...review,
      auditEntryId: new Types.ObjectId(review.auditEntryId),
      reviewedAt,
    }));
    try {
      await this.reviewModel.insertMany(documents, { ordered: false });
      return documents.map(document => String(document.auditEntryId));
    } catch (error) {
      const failures = readInsertFailures(error);
      // Only a duplicate key (a concurrent review of the same entry) is tolerated.
      if (!failures || failures.some(({ code, index }) => code !== DUPLICATE_KEY_ERROR_CODE || index < 0)) throw error;
      const failedIndexes = new Set(failures.map(({ index }) => index));
      return documents.filter((_, index) => !failedIndexes.has(index)).map(({ auditEntryId }) => String(auditEntryId));
    }
  }

  async findByEntryIds(entryIds: string[]): Promise<AuditReview[]> {
    if (entryIds.length === 0) return [];
    const documents = await this.reviewModel
      .find({ auditEntryId: { $in: entryIds.map(id => new Types.ObjectId(id)) } })
      .lean<AdminAuditReviewDocumentShape[]>();
    return documents.map(toAuditReview);
  }

  async deleteByReviewer(entryIds: string[], reviewerUserId: string): Promise<string[]> {
    if (entryIds.length === 0) return [];
    const filter = {
      auditEntryId: { $in: entryIds.map(id => new Types.ObjectId(id)) },
      'reviewer.userId': reviewerUserId,
    };
    const matching = await this.reviewModel
      .find(filter)
      .select({ auditEntryId: 1 })
      .lean<Array<Pick<AdminAuditReviewDocumentShape, 'auditEntryId'>>>();
    if (matching.length === 0) return [];
    await this.reviewModel.deleteMany(filter);
    return matching.map(({ auditEntryId }) => String(auditEntryId));
  }
}

export const adminAuditReviewRepository: IAdminAuditReviewRepository = new AdminAuditReviewRepository(
  AdminAuditReviewModel
);
