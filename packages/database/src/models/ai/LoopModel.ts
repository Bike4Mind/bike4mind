import mongoose, { Model, Schema, model } from 'mongoose';
import {
  DEFAULT_LOOP_STAGES,
  ILoop,
  ILoopRepository,
  LOOP_AUTO_RESUME_KINDS,
  LOOP_STAGE_RUNNERS,
  LOOP_STATUSES,
  LoopAutoResume,
  LoopStatus,
} from '@bike4mind/common';
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
    expectedStatus?: LoopStatus,
    guard?: { stages?: string[] }
  ): Promise<ILoop | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) unset[key] = '';
      else if (value !== undefined) set[key] = value;
    }
    const result = await this.loopModel.findOneAndUpdate(
      {
        _id: id,
        userId,
        ...(expectedStatus && { status: expectedStatus }),
        ...(guard?.stages && { stages: guard.stages }),
      },
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

  async claimDue(
    now: Date,
    leaseMs: number,
    skipIds: string[] = [],
    skipUserIds: string[] = []
  ): Promise<ILoop | null> {
    const result = await this.loopModel.findOneAndUpdate(
      {
        ...(skipIds.length > 0 && { _id: { $nin: skipIds } }),
        ...(skipUserIds.length > 0 && { userId: { $nin: skipUserIds } }),
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

  /** Pushes a claimed live loop's next run out without pausing it, and releases the claim. */
  async deferUntil(id: string, nextRunAt: Date): Promise<void> {
    const result = await this.loopModel.updateOne(
      { _id: id, status: 'live' },
      { $set: { nextRunAt }, $unset: { leaseUntil: '' } }
    );
    if (result.matchedCount === 0) await this.releaseLease(id);
  }

  /**
   * Pauses every live loop of a user; conditional on `live`, so an owner pause is never overwritten. A loop
   * with a run in flight is left live (its fold would rewrite the pause); admission pauses it on its next claim.
   */
  async pauseAllLiveForUser(
    userId: string,
    patch: { statusReason: string; autoResume: LoopAutoResume; nextRunAt: Date }
  ): Promise<number> {
    const result = await this.loopModel.updateMany(
      { userId, status: 'live', activeExecutionId: { $exists: false } },
      { $set: { status: 'paused', ...patch }, $unset: { leaseUntil: '' } }
    );
    return result.modifiedCount;
  }

  async countInFlight(): Promise<number> {
    return this.loopModel.countDocuments({ activeExecutionId: { $exists: true } });
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

  /** Also ends an idle back-off: something changed, so the loop has work worth a run again. */
  async makeDueNow(id: string, now: Date): Promise<void> {
    // $min over a missing nextRunAt yields `now` (aggregation $min ignores missing values).
    await this.loopModel.updateOne({ _id: id, status: 'live' }, [
      { $set: { nextRunAt: { $min: ['$nextRunAt', now] }, idleStreak: 0, idleResetAt: now } },
    ]);
  }

  /** Ends a live loop's idle back-off without making it due now: it next runs by `nextRunAt` at the latest. */
  async endBackoff(id: string, nextRunAt: Date): Promise<void> {
    // Conditional on 'live': a paused loop's nextRunAt is its auto-resume time.
    // Stamped even when not backing off, so a run in flight is not folded as idle (see idleResetAt).
    await this.loopModel.updateOne({ _id: id, status: 'live' }, [
      {
        $set: {
          nextRunAt: { $cond: [{ $gt: ['$idleStreak', 0] }, { $min: ['$nextRunAt', nextRunAt] }, '$nextRunAt'] },
          idleStreak: 0,
          idleResetAt: '$$NOW',
        },
      },
    ]);
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

  async listAutoPaused(): Promise<ILoop[]> {
    const results = await this.loopModel.find({ status: 'paused', autoResume: { $exists: true } });
    return results.map(doc => doc.toJSON());
  }

  async resumeAutoPaused(id: string, kind: LoopAutoResume, now: Date): Promise<boolean> {
    const result = await this.loopModel.updateOne(
      { _id: id, status: 'paused', autoResume: kind },
      { $set: { status: 'live', nextRunAt: now }, $unset: { autoResume: '', statusReason: '' } }
    );
    return result.modifiedCount > 0;
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
    // Kept in sync with validateLoopStageConfig (apps/client/server/utils/loopValidation.ts).
    stageConfig: {
      type: [
        new Schema(
          {
            stage: { type: String, required: true },
            instructions: { type: String },
            model: { type: String },
            tools: { type: [String], default: undefined },
            runner: { type: String, enum: LOOP_STAGE_RUNNERS },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    // Kept in sync with validateLoopBudget (apps/client/server/utils/loopValidation.ts).
    budgetCreditsPerDay: {
      type: Number,
      validate: { validator: (value: number) => value > 0, message: 'budgetCreditsPerDay must be positive' },
    },
    status: { type: String, enum: LOOP_STATUSES, required: true, default: 'draft' },
    statusReason: { type: String },
    autoResume: { type: String, enum: LOOP_AUTO_RESUME_KINDS },
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
    idleStreak: { type: Number, default: 0 },
    idleResetAt: { type: Date },
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
