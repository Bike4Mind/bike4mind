import mongoose, { Model, Schema, model } from 'mongoose';
import {
  DEFAULT_LOOP_STAGES,
  ILoop,
  ILoopAlarm,
  ILoopRepository,
  LOOP_ALARM_KINDS,
  LOOP_AUTO_RESUME_KINDS,
  LOOP_CAPACITY_LIMITS,
  LOOP_HOLD_KINDS,
  LOOP_MAX_CONCURRENT,
  LOOP_MEMORY_TAIL_CHARS,
  LOOP_MERGE_POLICIES,
  LOOP_STAGE_RUNNERS,
  LOOP_STATUSES,
  LoopAlarmKind,
  LoopAutoResume,
  LoopCapacityLimit,
  LoopRunMemory,
  LoopStatus,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'Loop';

/** A free cloud lane: fewer runs in flight than `maxConcurrent` (absent: 1). Shared by `claimDue` and `setCapacityHolds`. */
const LANE_FREE = {
  $expr: { $lt: [{ $size: { $ifNull: ['$activeExecutionIds', []] } }, { $ifNull: ['$maxConcurrent', 1] }] },
};
const NO_LANE_ACTIVE = { 'activeExecutionIds.0': { $exists: false } };
const ANY_LANE_ACTIVE = { 'activeExecutionIds.0': { $exists: true } };

/**
 * Pipeline expression for a finished run's memory: its own when nothing wrote the loop's memory since the run
 * started; else the loop's notes plus a `[parallel run]` marker and the run's notes, tail-clipped. `nextAction` is
 * the last writer's. Every run string is $literal: a pipeline update reads a leading '$' as a field path.
 */
function mergedMemory(run: LoopRunMemory) {
  const marker = run.ticketTitle
    ? `[parallel run, ticket ${JSON.stringify(run.ticketTitle.slice(0, 120))}]`
    : '[parallel run]';
  const joined = { $concat: [{ $ifNull: ['$memory.notes', ''] }, { $literal: `\n\n${marker} ${run.notes}` }] };
  const tail = {
    $let: {
      vars: { s: joined },
      in: {
        $substrCP: [
          '$$s',
          { $max: [0, { $subtract: [{ $strLenCP: '$$s' }, LOOP_MEMORY_TAIL_CHARS] }] },
          LOOP_MEMORY_TAIL_CHARS,
        ],
      },
    },
  };
  const unchanged = {
    $or: [{ $eq: [{ $ifNull: ['$memory.updatedAt', null] }, null] }, { $lte: ['$memory.updatedAt', run.startedAt] }],
  };
  return {
    notes: { $cond: [unchanged, { $literal: run.notes }, tail] },
    nextAction: { $literal: run.nextAction },
    updatedAt: run.updatedAt,
  };
}

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
        ...LANE_FREE,
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

  async markDispatched(id: string, executionId: string, nextRunAt: Date, laneHoldAt?: Date): Promise<void> {
    await this.loopModel.updateOne({ _id: id }, [
      {
        $set: {
          activeExecutionIds: {
            $concatArrays: [{ $ifNull: ['$activeExecutionIds', []] }, [{ $literal: executionId }]],
          },
          lastExecutionId: { $literal: executionId },
          nextRunAt,
          hold: laneHoldAt ? { $literal: { kind: 'capacity', limit: 'loop', at: laneHoldAt } } : '$$REMOVE',
          // Another lane's long_run alarm stays; an idle alarm ends with this run.
          alarm: { $cond: [{ $eq: ['$alarm.kind', 'idle_with_work'] }, '$$REMOVE', '$alarm'] },
        },
      },
      { $unset: ['leaseUntil'] },
    ]);
  }

  /** Pushes a claimed live loop's next run out without pausing it, and releases the claim. */
  async deferUntil(id: string, nextRunAt: Date, now: Date): Promise<void> {
    const result = await this.loopModel.updateOne(
      { _id: id, status: 'live' },
      { $set: { nextRunAt, hold: { kind: 'pacing', until: nextRunAt, at: now } }, $unset: { leaseUntil: '' } }
    );
    if (result.matchedCount === 0) await this.releaseLease(id);
  }

  async holdForCapacity(id: string, limit: LoopCapacityLimit, now: Date): Promise<void> {
    const result = await this.loopModel.updateOne(
      { _id: id, status: 'live' },
      { $set: { hold: { kind: 'capacity', limit, at: now } }, $unset: { leaseUntil: '' } }
    );
    if (result.matchedCount === 0) await this.releaseLease(id);
  }

  // The hold/alarm queries state `$exists: true` so the planner can use their partial indexes.
  async clearCapacityHolds(): Promise<void> {
    await this.loopModel.updateMany(
      { hold: { $exists: true }, 'hold.kind': 'capacity', 'hold.limit': { $ne: 'loop' } },
      { $unset: { hold: '' } }
    );
  }

  /** Same filter as `claimDue`, so only loops the run cap kept out this tick are marked. */
  async setCapacityHolds(now: Date, skipIds: string[]): Promise<void> {
    await this.loopModel.updateMany(
      {
        ...(skipIds.length > 0 && { _id: { $nin: skipIds } }),
        status: 'live',
        nextRunAt: { $lte: now },
        ...LANE_FREE,
        $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }],
      },
      { $set: { hold: { kind: 'capacity', limit: 'server', at: now } } }
    );
  }

  async listPastDueLive(before: Date, limit: number): Promise<ILoop[]> {
    const results = await this.loopModel
      // Capacity-held and backing-off loops never qualify, so they must not fill the window ahead of ones that do.
      .find({
        status: 'live',
        nextRunAt: { $lte: before },
        ...NO_LANE_ACTIVE,
        'hold.kind': { $ne: 'capacity' },
        idleStreak: { $not: { $gt: 0 } },
      })
      .sort({ nextRunAt: 1 })
      .limit(limit);
    return results.map(doc => doc.toJSON());
  }

  async listAlarmed(kinds?: LoopAlarmKind[]): Promise<ILoop[]> {
    // Both predicates are needed for the partial `alarm.kind` index; `alarm` alone scans the collection.
    const results = await this.loopModel.find({
      alarm: { $exists: true },
      'alarm.kind': { $in: kinds ?? LOOP_ALARM_KINDS },
    });
    return results.map(doc => doc.toJSON());
  }

  async setAlarm(id: string, alarm: ILoopAlarm): Promise<void> {
    const same = {
      $and: [
        { $eq: ['$alarm.kind', alarm.kind] },
        { $eq: [{ $ifNull: ['$alarm.executionId', null] }, alarm.executionId ?? null] },
      ],
    };
    // Only while the alarm still applies: a long run while it is an active run, an idle alarm while live and idle.
    const stillApplies = alarm.executionId
      ? { activeExecutionIds: alarm.executionId }
      : { status: 'live', ...NO_LANE_ACTIVE };
    await this.loopModel.updateOne({ _id: id, ...stillApplies }, [
      {
        $set: {
          alarm: {
            kind: alarm.kind,
            // $literal: a pipeline update would read a reason starting with '$' as a field path.
            reason: { $literal: alarm.reason },
            since: { $cond: [same, '$alarm.since', alarm.since] },
            // An object in a pipeline $set merges into the old alarm, so drop a stale executionId explicitly.
            executionId: alarm.executionId ?? '$$REMOVE',
          },
        },
      },
    ]);
  }

  async clearAlarm(id: string, kind: LoopAlarmKind): Promise<void> {
    await this.loopModel.updateOne(
      { _id: id, alarm: { $exists: true }, 'alarm.kind': kind },
      { $unset: { alarm: '' } }
    );
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
      { userId, status: 'live', ...NO_LANE_ACTIVE },
      { $set: { status: 'paused', ...patch }, $unset: { leaseUntil: '' } }
    );
    return result.modifiedCount;
  }

  private async countLanes(match: Record<string, unknown>): Promise<number> {
    const [row] = await this.loopModel.aggregate<{ lanes: number }>([
      { $match: { ...match, ...ANY_LANE_ACTIVE } },
      { $group: { _id: null, lanes: { $sum: { $size: '$activeExecutionIds' } } } },
    ]);
    return row?.lanes ?? 0;
  }

  async countInFlight(): Promise<number> {
    return this.countLanes({});
  }

  async countLanesForUser(userId: string): Promise<number> {
    return this.countLanes({ userId });
  }

  async listInFlight(): Promise<ILoop[]> {
    const results = await this.loopModel.find(ANY_LANE_ACTIVE);
    return results.map(doc => doc.toJSON());
  }

  async foldRun(
    id: string,
    executionId: string,
    update: { $set?: Record<string, unknown>; $inc?: Record<string, number>; $unset?: Record<string, ''> },
    memory?: LoopRunMemory
  ): Promise<boolean> {
    const result = await this.loopModel.updateOne(
      { _id: id, activeExecutionIds: executionId },
      { ...update, $pull: { activeExecutionIds: executionId } }
    );
    if (result.modifiedCount === 0) return false;
    // A second write, so the classic $inc/$unset above need no pipeline form. A lane just freed, so the loop-lane
    // hold goes; another lane's long_run alarm stays.
    await this.loopModel.updateOne({ _id: id }, [
      {
        $set: {
          alarm: {
            $cond: [
              { $and: [{ $eq: ['$alarm.kind', 'long_run'] }, { $eq: ['$alarm.executionId', executionId] }] },
              '$$REMOVE',
              '$alarm',
            ],
          },
          hold: {
            $cond: [
              { $and: [{ $eq: ['$hold.kind', 'capacity'] }, { $eq: ['$hold.limit', 'loop'] }] },
              '$$REMOVE',
              '$hold',
            ],
          },
          ...(memory && { memory: mergedMemory(memory) }),
        },
      },
    ]);
    return true;
  }

  /** Also ends an idle back-off: something changed, so the loop has work worth a run again. */
  async makeDueNow(id: string, now: Date): Promise<boolean> {
    // $min over a missing nextRunAt yields `now` (aggregation $min ignores missing values).
    const result = await this.loopModel.updateOne({ _id: id, status: 'live' }, [
      { $set: { nextRunAt: { $min: ['$nextRunAt', now] }, idleStreak: 0, idleResetAt: now } },
    ]);
    return result.matchedCount > 0;
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

  async foldRunnerRun(id: string, userId: string, run: LoopRunMemory, lastRunAt: Date): Promise<void> {
    await this.loopModel.updateOne({ _id: id, userId }, [
      { $set: { memory: mergedMemory(run), lastRunAt, runCount: { $add: [{ $ifNull: ['$runCount', 0] }, 1] } } },
    ]);
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
            repoHint: { type: String },
            mergePolicy: { type: String, enum: LOOP_MERGE_POLICIES },
            deployWorkflow: { type: String },
            smoke: { type: new Schema({ url: { type: String }, command: { type: String } }, { _id: false }) },
            holdLabels: { type: [String], default: undefined },
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
    activeExecutionIds: { type: [String], default: undefined },
    // Kept in sync with validateLoopMaxConcurrent (apps/client/server/utils/loopValidation.ts).
    maxConcurrent: {
      type: Number,
      min: 1,
      max: LOOP_MAX_CONCURRENT,
      validate: { validator: Number.isInteger, message: 'maxConcurrent must be an integer' },
    },
    leaseUntil: { type: Date },
    runCount: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },
    idleStreak: { type: Number, default: 0 },
    idleResetAt: { type: Date },
    oversees: { type: [String], default: undefined },
    hold: {
      type: new Schema(
        {
          kind: { type: String, enum: LOOP_HOLD_KINDS, required: true },
          until: Date,
          limit: { type: String, enum: LOOP_CAPACITY_LIMITS },
          at: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    alarm: {
      type: new Schema(
        {
          kind: { type: String, enum: LOOP_ALARM_KINDS, required: true },
          reason: { type: String, required: true },
          since: { type: Date, required: true },
          executionId: { type: String },
        },
        { _id: false }
      ),
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: true },
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LoopSchema.index({ status: 1, nextRunAt: 1 });
LoopSchema.index({ activeExecutionIds: 1 }, { partialFilterExpression: { 'activeExecutionIds.0': { $exists: true } } });
LoopSchema.index({ userId: 1, updatedAt: -1 });
LoopSchema.index({ 'alarm.kind': 1 }, { partialFilterExpression: { alarm: { $exists: true } } });
LoopSchema.index({ 'hold.kind': 1 }, { partialFilterExpression: { hold: { $exists: true } } });

export const Loop: ILoopModel =
  (mongoose.models[ModelName] as unknown as ILoopModel) ?? model<ILoop, ILoopModel>(ModelName, LoopSchema);

export const loopRepository = new LoopRepository(Loop);

export default Loop;
