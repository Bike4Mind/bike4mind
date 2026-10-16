import mongoose, { Model, Schema } from 'mongoose';
import { ITransformBatch, ITransformBatchRepository } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';

interface ITransformBatchMethods {}

interface ITransformBatchModel extends Model<ITransformBatch, {}, ITransformBatchMethods> {}

const TransformBatchSchema = new Schema<ITransformBatch, ITransformBatchModel, ITransformBatchMethods>(
  {
    ownerUserId: { type: String, required: true, index: true },
    anthropicBatchId: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ['in_progress', 'completed'],
      required: true,
      default: 'in_progress',
      index: true,
    },
    requestCount: { type: Number, required: true },
    succeededCount: { type: Number, default: 0 },
    erroredCount: { type: Number, default: 0 },
    customIdMap: {
      type: [
        new Schema(
          {
            customId: { type: String, required: true },
            clientRef: { type: String, required: true },
            model: { type: String },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    // Cached per-request results (set once the batch ends) so polls after
    // completion don't re-stream the JSONL from Anthropic. Mixed shape ->
    // Schema.Types.Mixed; validated by the ITransformBatchResultItem type.
    results: { type: Schema.Types.Mixed, required: false },
    creditHold: { type: Schema.Types.Mixed, default: null },
    creditSettledAt: { type: Date },
    apiKeyId: { type: String },
    usageSource: { type: String },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

TransformBatchSchema.plugin(softDeletePlugin);

export const TransformBatch =
  (mongoose.models.TransformBatch as ITransformBatchModel) ??
  mongoose.model<ITransformBatch, ITransformBatchModel>('TransformBatch', TransformBatchSchema);

class TransformBatchRepository extends BaseRepository<ITransformBatch> implements ITransformBatchRepository {
  constructor(model: ITransformBatchModel) {
    super(model);
  }

  async findByAnthropicBatchId(anthropicBatchId: ITransformBatch['anthropicBatchId']) {
    return this.model.findOne({ anthropicBatchId });
  }

  async claimCompletion(id: string, update: Pick<ITransformBatch, 'succeededCount' | 'erroredCount'>) {
    return this.model.findOneAndUpdate(
      { _id: id, status: 'in_progress' },
      { $set: { ...update, status: 'completed' } },
      { new: false }
    );
  }

  async markCreditSettled(id: string) {
    await this.model.updateOne(
      { _id: id, creditSettledAt: { $exists: false } },
      { $set: { creditHold: null, creditSettledAt: new Date() } }
    );
  }

  async saveResults(id: string, results: NonNullable<ITransformBatch['results']>) {
    await this.model.updateOne({ _id: id }, { $set: { results } });
  }
}

export const transformBatchRepository = new TransformBatchRepository(TransformBatch);
