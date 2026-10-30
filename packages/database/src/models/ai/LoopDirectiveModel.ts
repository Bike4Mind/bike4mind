import mongoose, { Model, Schema, model } from 'mongoose';
import {
  ILoopDirective,
  ILoopDirectiveReply,
  ILoopDirectiveRepository,
  LOOP_DIRECTIVE_INSTRUCTION_MAX,
  LOOP_DIRECTIVE_NOTE_MAX,
  LOOP_DIRECTIVE_REASON_MAX,
  LOOP_DIRECTIVE_STATES,
  LoopDirectiveState,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'LoopDirective';

export interface ILoopDirectiveModel extends Model<ILoopDirective> {}

export class LoopDirectiveRepository extends BaseRepository<ILoopDirective> implements ILoopDirectiveRepository {
  constructor(private loopDirectiveModel: ILoopDirectiveModel) {
    super(loopDirectiveModel);
    this.loopDirectiveModel = loopDirectiveModel;
  }

  async countByExecution(executionId: string): Promise<number> {
    return this.loopDirectiveModel.countDocuments({ executionId });
  }

  async listOpenForLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]> {
    const results = await this.loopDirectiveModel
      .find({ userId, loopId, state: { $in: ['open', 'accepted'] } })
      // 'open' > 'accepted' lexically, so unanswered directives come first and are never starved by accepted ones.
      .sort({ state: -1, createdAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listToLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]> {
    const results = await this.loopDirectiveModel.find({ userId, loopId }).sort({ createdAt: -1 }).limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listForLoop(userId: string, loopId: string, limit: number): Promise<ILoopDirective[]> {
    const results = await this.loopDirectiveModel
      .find({ userId, $or: [{ loopId }, { fromLoopId: loopId }] })
      .sort({ createdAt: -1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async findByIdForUser(id: string, userId: string): Promise<ILoopDirective | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.loopDirectiveModel.findOne({ _id: id, userId });
    return result?.toJSON() ?? null;
  }

  async transition(
    id: string,
    userId: string,
    from: readonly LoopDirectiveState[],
    to: LoopDirectiveState,
    reply: ILoopDirectiveReply
  ): Promise<ILoopDirective | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.loopDirectiveModel.findOneAndUpdate(
      { _id: id, userId, state: { $in: from } },
      { $set: { state: to }, $push: { replies: reply } },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  /** Directives to the loop only: those it issued stay in their workers' logs. */
  async deleteManyForLoop(userId: string, loopId: string): Promise<number> {
    const result = await this.loopDirectiveModel.deleteMany({ userId, loopId });
    return result.deletedCount;
  }
}

const ReplySchema = new Schema(
  {
    by: { type: String, enum: ['worker', 'owner'], required: true },
    outcome: {
      type: String,
      enum: ['accepted', 'pushed_back', 'done', 'withdrawn', 'overruled'],
      required: true,
    },
    note: { type: String, maxlength: LOOP_DIRECTIVE_NOTE_MAX },
    executionId: { type: String },
    userId: { type: String },
    at: { type: Date, required: true },
  },
  { _id: false }
);

export const LoopDirectiveSchema = new Schema<ILoopDirective, ILoopDirectiveModel>(
  {
    loopId: { type: String, required: true },
    userId: { type: String, required: true },
    fromLoopId: { type: String, required: true },
    fromLoopName: { type: String, required: true },
    executionId: { type: String, required: true },
    instruction: { type: String, required: true, maxlength: LOOP_DIRECTIVE_INSTRUCTION_MAX },
    reason: { type: String, required: true, maxlength: LOOP_DIRECTIVE_REASON_MAX },
    state: { type: String, enum: LOOP_DIRECTIVE_STATES, required: true, default: 'open' },
    replies: { type: [ReplySchema], default: [] },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// No TTL, like LoopEvent: the thread outlives the execution TTL and is deleted with its worker loop.
LoopDirectiveSchema.index({ loopId: 1, createdAt: -1 });
LoopDirectiveSchema.index({ fromLoopId: 1, createdAt: -1 });
LoopDirectiveSchema.index({ loopId: 1, state: 1, createdAt: 1 });
LoopDirectiveSchema.index({ executionId: 1 });

export const LoopDirective: ILoopDirectiveModel =
  (mongoose.models[ModelName] as unknown as ILoopDirectiveModel) ??
  model<ILoopDirective, ILoopDirectiveModel>(ModelName, LoopDirectiveSchema);

export const loopDirectiveRepository = new LoopDirectiveRepository(LoopDirective);

export default LoopDirective;
