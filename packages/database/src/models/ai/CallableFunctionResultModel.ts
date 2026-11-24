import {
  CALLABLE_FUNCTION_CALL_OUTCOMES,
  CALLABLE_FUNCTION_RESULT_MAX_BYTES,
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
    state: { type: String, enum: CALLABLE_FUNCTION_RESULT_STATES, required: true },
    input: { type: Schema.Types.Mixed },
    outcome: { type: String, enum: CALLABLE_FUNCTION_CALL_OUTCOMES },
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
    row: Pick<ICallableFunctionResult, 'callId' | 'callerUserId' | 'functionId' | 'apiKeyId' | 'input'>
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
   * Stores how the call ended and drops its inputs. Outputs over the 5 MB cap are not stored; the call reads
   * `output_too_large` instead. Returns the outcome as stored.
   */
  async finish(callId: string, end: CallableFunctionResultEnd): Promise<CallableFunctionResultEnd['outcome']> {
    const tooLarge = end.outputs !== undefined && jsonBytes(end.outputs) > CALLABLE_FUNCTION_RESULT_MAX_BYTES;
    const stored: CallableFunctionResultEnd = tooLarge
      ? { outcome: 'output_too_large', reason: 'result_too_large', ...(end.stamp ? { stamp: end.stamp } : {}) }
      : end;
    const set = Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== undefined));
    await this.model.updateOne(
      { callId },
      { $set: { ...set, state: 'finished' }, $unset: { input: 1 } },
      { runValidators: true }
    );
    return stored.outcome;
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
