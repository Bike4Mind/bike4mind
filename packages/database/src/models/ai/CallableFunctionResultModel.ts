import {
  CALLABLE_FUNCTION_RESULT_MAX_BYTES,
  CALLABLE_FUNCTION_RESULT_OUTCOMES,
  CALLABLE_FUNCTION_RESULT_STATES,
  CALLABLE_FUNCTION_RESULT_TTL_SECONDS,
  type ICallableFunctionResult,
  type ICallableFunctionResultDocument,
  type IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const CODE = /^[a-z0-9_]{1,40}$/;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;

const CallableFunctionResultSchema = new Schema<ICallableFunctionResultDocument>(
  {
    callId: { type: String, required: true, unique: true },
    callerUserId: { type: String, required: true },
    functionId: { type: String, required: true, maxlength: 64 },
    apiKeyId: { type: String },
    organizationId: { type: String },
    state: { type: String, enum: CALLABLE_FUNCTION_RESULT_STATES, required: true },
    input: { type: Schema.Types.Mixed },
    outcome: { type: String, enum: CALLABLE_FUNCTION_RESULT_OUTCOMES },
    reason: { type: String, match: CODE },
    errorClass: { type: String, match: CLASS_NAME },
    problems: { type: Schema.Types.Mixed },
    outputs: { type: Schema.Types.Mixed },
    stamp: { type: Schema.Types.Mixed },
  },
  { timestamps: true, strict: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

CallableFunctionResultSchema.index({ callerUserId: 1, createdAt: -1 }, { name: 'callablefnresult_caller_created' });
CallableFunctionResultSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: CALLABLE_FUNCTION_RESULT_TTL_SECONDS, name: 'callablefnresult_ttl' }
);

export interface ICallableFunctionResultModel extends Model<ICallableFunctionResultDocument & IMongoDocument> {}
export const CallableFunctionResult: ICallableFunctionResultModel =
  mongoose.models.CallableFunctionResult ??
  model<ICallableFunctionResultDocument>('CallableFunctionResult', CallableFunctionResultSchema);

export type CallableFunctionResultEnd = Pick<
  ICallableFunctionResult,
  'outcome' | 'reason' | 'errorClass' | 'problems' | 'outputs' | 'stamp'
>;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');

class CallableFunctionResultRepository extends BaseRepository<ICallableFunctionResultDocument & IMongoDocument> {
  async createQueued(
    row: Pick<
      ICallableFunctionResult,
      'callId' | 'callerUserId' | 'functionId' | 'apiKeyId' | 'organizationId' | 'input'
    >
  ): Promise<ICallableFunctionResultDocument> {
    return this.create({ ...row, state: 'queued' });
  }

  /** Moves a queued call to `running` and returns it with its inputs; null once anything else has claimed it. */
  async claim(callId: string): Promise<ICallableFunctionResultDocument | null> {
    return this.model.findOneAndUpdate(
      { callId, state: 'queued' },
      { $set: { state: 'running' } },
      { new: true, runValidators: true }
    );
  }

  /**
   * Ends a call still `running` since before `staleBefore` as `error`/`worker_lost`, in one guarded update so a live
   * worker's result is never overwritten. Returns true when the call reads `worker_lost` afterwards, whether this
   * call ended it or an earlier one did, and false when it is not that old or ended another way.
   */
  async endLost(callId: string, staleBefore: Date): Promise<boolean> {
    const ended = await this.model.updateOne(
      { callId, state: 'running', updatedAt: { $lt: staleBefore } },
      { $set: { state: 'finished', outcome: 'error', reason: 'worker_lost' }, $unset: { input: 1 } },
      { runValidators: true }
    );
    if (ended.modifiedCount === 1) return true;
    return (await this.model.exists({ callId, state: 'finished', outcome: 'error', reason: 'worker_lost' })) !== null;
  }

  /**
   * Ends a call still `queued` since before `queuedBefore` as `error`/`worker_lost`, guarded so a claim that lands
   * first wins. Returns true when this call ended it.
   */
  async endUnclaimed(callId: string, queuedBefore: Date): Promise<boolean> {
    const ended = await this.model.updateOne(
      { callId, state: 'queued', createdAt: { $lt: queuedBefore } },
      { $set: { state: 'finished', outcome: 'error', reason: 'worker_lost' }, $unset: { input: 1 } },
      { runValidators: true }
    );
    return ended.modifiedCount === 1;
  }

  /** The caller's calls still `queued` since `queuedSince` or `running` since `runningSince`. */
  async countPending(callerUserId: string, since: { queuedSince: Date; runningSince: Date }): Promise<number> {
    return this.model.countDocuments({
      callerUserId,
      $or: [
        { state: 'queued', createdAt: { $gte: since.queuedSince } },
        { state: 'running', updatedAt: { $gte: since.runningSince } },
      ],
    });
  }

  /**
   * Stores how the call ended and drops its inputs. Outputs over the 5 MB cap are not stored; the call reads
   * `output_too_large` instead. A cancelled call is left as it is. Returns the outcome as stored.
   */
  async finish(callId: string, end: CallableFunctionResultEnd): Promise<CallableFunctionResultEnd['outcome']> {
    const tooLarge = end.outputs !== undefined && jsonBytes(end.outputs) > CALLABLE_FUNCTION_RESULT_MAX_BYTES;
    const stored: CallableFunctionResultEnd = tooLarge
      ? { outcome: 'output_too_large', reason: 'result_too_large', ...(end.stamp ? { stamp: end.stamp } : {}) }
      : end;
    const set = Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== undefined));
    const ended = await this.model.updateOne(
      { callId, outcome: { $ne: 'cancelled' } },
      { $set: { ...set, state: 'finished' }, $unset: { input: 1 } },
      { runValidators: true }
    );
    if (ended.matchedCount === 0 && (await this.model.exists({ callId, outcome: 'cancelled' })) !== null) {
      return 'cancelled';
    }
    return stored.outcome;
  }

  /**
   * Ends the caller's own call as `cancelled` while it is `queued` or `running`, so it is never claimed and a run
   * still going cannot store its result. Returns the cancelled call; null when it had already finished or is not
   * the caller's.
   */
  async cancel(callId: string, callerUserId: string): Promise<ICallableFunctionResultDocument | null> {
    const keptSince = new Date(Date.now() - CALLABLE_FUNCTION_RESULT_TTL_SECONDS * 1000);
    return this.model.findOneAndUpdate(
      { callId, callerUserId, state: { $in: ['queued', 'running'] }, createdAt: { $gt: keptSince } },
      { $set: { state: 'finished', outcome: 'cancelled' }, $unset: { input: 1 } },
      { new: true, runValidators: true, projection: { input: 0 } }
    );
  }

  /**
   * The caller's own call while it is kept. The age check makes 24 hours exact; the TTL index only removes the
   * document some time after.
   */
  async findForCaller(
    callId: string,
    callerUserId: string,
    now: Date = new Date()
  ): Promise<ICallableFunctionResultDocument | null> {
    const keptSince = new Date(now.getTime() - CALLABLE_FUNCTION_RESULT_TTL_SECONDS * 1000);
    return this.model.findOne({ callId, callerUserId, createdAt: { $gt: keptSince } }, { input: 0 });
  }
}

export const callableFunctionResultRepository = new CallableFunctionResultRepository(CallableFunctionResult);

export default CallableFunctionResult;
