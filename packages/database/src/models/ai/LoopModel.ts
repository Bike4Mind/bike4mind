import mongoose, { Model, Schema, model } from 'mongoose';
import { DEFAULT_LOOP_STAGES, ILoop, ILoopRepository, LOOP_STATUSES, LoopStatus } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'Loop';

export interface ILoopModel extends Model<ILoop> {}

export class LoopRepository extends BaseRepository<ILoop> implements ILoopRepository {
  constructor(private loopModel: ILoopModel) {
    super(loopModel);
    this.loopModel = loopModel;
  }

  async listForUser(userId: string): Promise<ILoop[]> {
    const results = await this.loopModel.find({ userId }).sort({ updatedAt: -1 });
    return results.map(doc => doc.toJSON());
  }

  async findByIdAndUserId(id: string, userId: string): Promise<ILoop | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.loopModel.findOne({ _id: id, userId });
    return result?.toJSON() ?? null;
  }

  async updateForUser(
    id: string,
    userId: string,
    patch: Record<string, unknown>,
    expectedStatus?: LoopStatus
  ): Promise<ILoop | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) unset[key] = '';
      else if (value !== undefined) set[key] = value;
    }
    const result = await this.loopModel.findOneAndUpdate(
      { _id: id, userId, ...(expectedStatus && { status: expectedStatus }) },
      {
        ...(Object.keys(set).length > 0 && { $set: set }),
        ...(Object.keys(unset).length > 0 && { $unset: unset }),
      },
      { new: true, runValidators: true }
    );
    return result?.toJSON() ?? null;
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.loopModel.deleteOne({ _id: id, userId });
    return result.deletedCount > 0;
  }

  async claimDue(now: Date, leaseMs: number, skipIds: string[] = []): Promise<ILoop | null> {
    const result = await this.loopModel.findOneAndUpdate(
      {
        ...(skipIds.length > 0 && { _id: { $nin: skipIds } }),
        status: 'live',
        nextRunAt: { $lte: now },
        activeExecutionId: { $exists: false },
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }],
      },
      { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } },
      { new: true, sort: { nextRunAt: 1 } }
    );
    return result?.toJSON() ?? null;
  }

  async releaseLease(id: string): Promise<void> {
    await this.loopModel.updateOne({ _id: id }, { $unset: { leaseUntil: '' } });
  }

  async markDispatched(id: string, executionId: string, nextRunAt: Date): Promise<void> {
    await this.loopModel.updateOne(
      { _id: id },
      {
        $set: { lastExecutionId: executionId, activeExecutionId: executionId, nextRunAt },
        $unset: { leaseUntil: '' },
      }
    );
  }

  async listInFlight(): Promise<ILoop[]> {
    const results = await this.loopModel.find({ activeExecutionId: { $exists: true } });
    return results.map(doc => doc.toJSON());
  }

  async foldRun(
    id: string,
    executionId: string,
    update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, ''> }
  ): Promise<boolean> {
    const result = await this.loopModel.updateOne(
      { _id: id, activeExecutionId: executionId },
      { ...update, $unset: { ...update.$unset, activeExecutionId: '' } }
    );
    return result.modifiedCount > 0;
  }

  async makeDueNow(id: string, now: Date): Promise<void> {
    await this.loopModel.updateOne(
      { _id: id, status: 'live', $or: [{ nextRunAt: { $exists: false } }, { nextRunAt: { $gt: now } }] },
      { $set: { nextRunAt: now } }
    );
  }

  async markErroredIfFailing(id: string, maxFailures: number): Promise<void> {
    await this.loopModel.updateOne(
      { _id: id, status: 'live', consecutiveFailures: { $gte: maxFailures } },
      { $set: { status: 'error' } }
    );
  }

  async removeFromOversees(userId: string, loopId: string): Promise<void> {
    await this.loopModel.updateMany({ userId, oversees: loopId }, { $pull: { oversees: loopId } });
  }
}

export const LoopSchema = new Schema<ILoop, ILoopModel>(
  {
    userId: { type: String, required: true },
    organizationId: { type: String },
    name: { type: String, required: true, maxlength: 120 },
    goal: { type: String, required: true, maxlength: 8000 },
    agentId: { type: String },
    model: { type: String, required: true },
    sessionId: { type: String, required: true },
    intervalMinutes: {
      type: Number,
      required: true,
      min: 5,
      validate: { validator: Number.isInteger, message: 'intervalMinutes must be an integer' },
    },
    tools: { type: [String], default: [] },
    stages: { type: [String], default: () => [...DEFAULT_LOOP_STAGES] },
    budgetCreditsPerDay: { type: Number, min: 0 },
    status: { type: String, enum: LOOP_STATUSES, required: true, default: 'draft' },
    statusReason: { type: String },
    memory: {
      type: new Schema(
        { notes: { type: String, default: '' }, nextAction: { type: String, default: '' }, updatedAt: Date },
        { _id: false }
      ),
      default: () => ({ notes: '', nextAction: '' }),
    },
    lastRunAt: { type: Date },
    nextRunAt: { type: Date },
    lastExecutionId: { type: String },
    activeExecutionId: { type: String },
    leaseUntil: { type: Date },
    runCount: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },
    oversees: { type: [String], default: undefined },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LoopSchema.index({ status: 1, nextRunAt: 1 });
LoopSchema.index({ activeExecutionId: 1 }, { partialFilterExpression: { activeExecutionId: { $exists: true } } });
LoopSchema.index({ userId: 1, updatedAt: -1 });

export const Loop: ILoopModel =
  (mongoose.models[ModelName] as unknown as ILoopModel) ?? model<ILoop, ILoopModel>(ModelName, LoopSchema);

export const loopRepository = new LoopRepository(Loop);

export default Loop;
