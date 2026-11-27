import {
  CALLABLE_FUNCTION_APPROVAL_MODES,
  type CallableFunctionApprovalMode,
  type CallableFunctionReviewedInterface,
  type ICallableFunctionReviewDocument,
  type IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const SHA256 = /^[0-9a-f]{64}$/;

const CallableFunctionReviewSchema = new Schema<ICallableFunctionReviewDocument>(
  {
    functionId: { type: String, required: true, maxlength: 64 },
    userId: { type: String, required: true },
    reviewHash: { type: String, required: true, match: SHA256 },
    approval: { type: String, enum: CALLABLE_FUNCTION_APPROVAL_MODES, required: true, default: 'default' },
    enabled: { type: Boolean, required: true, default: true },
    reviewedAt: { type: Date, required: true },
    reviewed: { type: Schema.Types.Mixed },
  },
  { timestamps: true, strict: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

CallableFunctionReviewSchema.index(
  { functionId: 1, userId: 1 },
  { unique: true, name: 'callablefnreview_function_user' }
);
CallableFunctionReviewSchema.index({ userId: 1 }, { name: 'callablefnreview_user' });

export interface ICallableFunctionReviewModel extends Model<ICallableFunctionReviewDocument & IMongoDocument> {}
export const CallableFunctionReview: ICallableFunctionReviewModel =
  mongoose.models.CallableFunctionReview ??
  model<ICallableFunctionReviewDocument>('CallableFunctionReview', CallableFunctionReviewSchema);

class CallableFunctionReviewRepository extends BaseRepository<ICallableFunctionReviewDocument & IMongoDocument> {
  async findFor(functionId: string, userId: string): Promise<ICallableFunctionReviewDocument | null> {
    const doc = await this.model.findOne({ functionId, userId });
    return doc?.toJSON() ?? null;
  }

  async findForUser(userId: string, functionIds: string[]): Promise<ICallableFunctionReviewDocument[]> {
    if (functionIds.length === 0) return [];
    const docs = await this.model.find({ userId, functionId: { $in: functionIds } });
    return docs.map(doc => doc.toJSON());
  }

  /** Records a review of `reviewHash`, which turns the function on for this person. */
  async saveReview(review: {
    functionId: string;
    userId: string;
    reviewHash: string;
    approval: CallableFunctionApprovalMode;
    reviewed?: CallableFunctionReviewedInterface;
  }): Promise<ICallableFunctionReviewDocument> {
    const { functionId, userId, reviewHash, approval, reviewed } = review;
    const save = () =>
      this.model.findOneAndUpdate(
        { functionId, userId },
        { $set: { reviewHash, approval, enabled: true, reviewedAt: new Date(), ...(reviewed ? { reviewed } : {}) } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
      );
    // Two upserts racing on the unique key: the loser updates the row the winner just inserted.
    const doc = await save().catch(error => {
      if ((error as { code?: number }).code !== 11000) throw error;
      return save();
    });
    return doc.toJSON();
  }

  /** Changes the approval mode or turns the function on or off; null when this person has no review. */
  async updateSettings(
    functionId: string,
    userId: string,
    settings: { approval?: CallableFunctionApprovalMode; enabled?: boolean }
  ): Promise<ICallableFunctionReviewDocument | null> {
    const doc = await this.model.findOneAndUpdate(
      { functionId, userId },
      { $set: settings },
      { new: true, runValidators: true }
    );
    return doc?.toJSON() ?? null;
  }

  async deleteForFunction(functionId: string): Promise<void> {
    await this.model.deleteMany({ functionId });
  }

  async deleteForUsers(functionId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.model.deleteMany({ functionId, userId: { $in: userIds } });
  }

  async deleteForFunctionExceptUsers(functionId: string, keepUserIds: string[]): Promise<void> {
    await this.model.deleteMany({ functionId, userId: { $nin: keepUserIds } });
  }

  async deleteForFunctions(functionIds: string[]): Promise<void> {
    if (functionIds.length === 0) return;
    await this.model.deleteMany({ functionId: { $in: functionIds } });
  }
}

export const callableFunctionReviewRepository = new CallableFunctionReviewRepository(CallableFunctionReview);

export default CallableFunctionReview;
