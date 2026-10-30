import mongoose, { Model, Schema, model } from 'mongoose';
import {
  ILoopEvent,
  ILoopEventRepository,
  LOOP_EVENT_KINDS,
  LoopGateOutcome,
  LoopUnsureFields,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'LoopEvent';

export interface ILoopEventModel extends Model<ILoopEvent> {}

export class LoopEventRepository extends BaseRepository<ILoopEvent> implements ILoopEventRepository {
  constructor(private loopEventModel: ILoopEventModel) {
    super(loopEventModel);
    this.loopEventModel = loopEventModel;
  }

  async recordUnsure(fields: LoopUnsureFields): Promise<void> {
    await this.loopEventModel.updateOne(
      { executionId: fields.executionId, requestedAt: fields.requestedAt },
      { $setOnInsert: { ...fields, kind: 'unsure' } },
      { upsert: true }
    );
  }

  async resolveUnsure(
    fields: LoopUnsureFields,
    resolution: { outcome: LoopGateOutcome; by?: string; at: Date }
  ): Promise<void> {
    await this.recordUnsure(fields);
    // Not an upsert: with `resolution` in the filter, an already-resolved event would insert a duplicate.
    await this.loopEventModel.updateOne(
      { executionId: fields.executionId, requestedAt: fields.requestedAt, resolution: { $exists: false } },
      { $set: { resolution } }
    );
  }

  async listForLoop(userId: string, loopId: string, limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel.find({ userId, loopId }).sort({ createdAt: -1 }).limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listResumedUnfolded(limit: number): Promise<ILoopEvent[]> {
    const results = await this.loopEventModel
      .find({ 'resolution.outcome': 'resumed', foldedAt: { $exists: false } })
      .sort({ createdAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async markFolded(id: string, now: Date): Promise<void> {
    await this.loopEventModel.updateOne({ _id: id, foldedAt: { $exists: false } }, { $set: { foldedAt: now } });
  }

  async deleteManyForLoop(userId: string, loopId: string): Promise<number> {
    const result = await this.loopEventModel.deleteMany({ userId, loopId });
    return result.deletedCount;
  }
}

export const LoopEventSchema = new Schema<ILoopEvent, ILoopEventModel>(
  {
    loopId: { type: String, required: true },
    userId: { type: String, required: true },
    kind: { type: String, enum: LOOP_EVENT_KINDS, required: true },
    executionId: { type: String, required: true },
    workItemId: { type: String },
    ticketTitle: { type: String },
    iteration: { type: Number, required: true },
    confidence: { type: Number, required: true },
    reason: { type: String, required: true },
    requestedAt: { type: Date, required: true },
    resolution: {
      type: new Schema(
        {
          outcome: { type: String, enum: ['resumed', 'rejected'], required: true },
          by: { type: String },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    foldedAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// No TTL: the log outlives the 90-day execution TTL and is deleted with its loop.
LoopEventSchema.index({ loopId: 1, createdAt: -1 });
LoopEventSchema.index({ executionId: 1, requestedAt: 1 }, { unique: true });
LoopEventSchema.index(
  { 'resolution.outcome': 1, foldedAt: 1 },
  { partialFilterExpression: { 'resolution.outcome': 'resumed' } }
);

export const LoopEvent: ILoopEventModel =
  (mongoose.models[ModelName] as unknown as ILoopEventModel) ??
  model<ILoopEvent, ILoopEventModel>(ModelName, LoopEventSchema);

export const loopEventRepository = new LoopEventRepository(LoopEvent);

export default LoopEvent;
