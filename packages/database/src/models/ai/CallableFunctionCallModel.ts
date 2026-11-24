import {
  CALLABLE_FUNCTION_CALL_OPS,
  CALLABLE_FUNCTION_CALL_OUTCOMES,
  CALLABLE_FUNCTION_CALL_SURFACES,
  type CallableFunctionCallOutcome,
  type CallableFunctionCallSummary,
  type ICallableFunctionCall,
  type ICallableFunctionCallDocument,
  type IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z0-9_]{1,40}$/;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;

const RuntimeSchema = new Schema(
  {
    kind: { type: String, required: true, maxlength: 40 },
    version: { type: String, required: true, maxlength: 40 },
    lockHash: { type: String, match: SHA256 },
  },
  { _id: false }
);

// Strict, so a field passed in by mistake (an input, an output) is dropped rather than stored.
const CallableFunctionCallSchema = new Schema<ICallableFunctionCallDocument>(
  {
    op: { type: String, enum: CALLABLE_FUNCTION_CALL_OPS, required: true },
    functionId: { type: String, required: true, maxlength: 64 },
    ownerUserId: { type: String },
    callerUserId: { type: String, required: true },
    apiKeyId: { type: String },
    organizationId: { type: String },
    surface: { type: String, enum: CALLABLE_FUNCTION_CALL_SURFACES, required: true },
    pinSeq: { type: Number },
    codeHash: { type: String, match: SHA256 },
    inputHash: { type: String, match: SHA256 },
    dataHashes: { type: [{ type: String, match: SHA256 }], default: [] },
    runtime: { type: RuntimeSchema },
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, required: true, min: 0 },
    initMs: { type: Number, min: 0 },
    inputBytes: { type: Number, min: 0 },
    outputBytes: { type: Number, min: 0 },
    outcome: { type: String, enum: CALLABLE_FUNCTION_CALL_OUTCOMES, required: true },
    reason: { type: String, match: CODE },
    errorClass: { type: String, match: CLASS_NAME },
  },
  { timestamps: true, strict: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

CallableFunctionCallSchema.index({ functionId: 1, startedAt: -1 }, { name: 'callablefncall_function_started' });
CallableFunctionCallSchema.index({ callerUserId: 1, startedAt: -1 }, { name: 'callablefncall_caller_started' });
// 90 days.
CallableFunctionCallSchema.index({ startedAt: 1 }, { expireAfterSeconds: 7776000, name: 'callablefncall_ttl' });

export interface ICallableFunctionCallModel extends Model<ICallableFunctionCallDocument & IMongoDocument> {}
export const CallableFunctionCall: ICallableFunctionCallModel =
  mongoose.models.CallableFunctionCall ??
  model<ICallableFunctionCallDocument>('CallableFunctionCall', CallableFunctionCallSchema);

class CallableFunctionCallRepository extends BaseRepository<ICallableFunctionCallDocument & IMongoDocument> {
  async record(row: ICallableFunctionCall): Promise<ICallableFunctionCallDocument> {
    return this.create(row);
  }

  /** One caller's calls of one function since `since`, read through `callablefncall_function_started`. */
  async summarizeForCaller(
    functionId: string,
    callerUserId: string,
    since: Date,
    recentLimit: number
  ): Promise<CallableFunctionCallSummary> {
    const match = { functionId, callerUserId, startedAt: { $gte: since } };
    const [counts, recent] = await Promise.all([
      this.model.aggregate<{ _id: CallableFunctionCallOutcome; count: number }>([
        { $match: match },
        { $group: { _id: '$outcome', count: { $sum: 1 } } },
      ]),
      this.model
        .find(match, { startedAt: 1, outcome: 1, surface: 1 })
        .sort({ startedAt: -1 })
        .limit(recentLimit)
        .lean(),
    ]);
    const outcomes: CallableFunctionCallSummary['outcomes'] = {};
    for (const { _id, count } of counts) outcomes[_id] = count;
    return {
      since,
      total: counts.reduce((sum, { count }) => sum + count, 0),
      outcomes,
      recent: recent.map(row => ({
        id: String(row._id),
        startedAt: row.startedAt,
        outcome: row.outcome,
        surface: row.surface,
      })),
    };
  }
}

export const callableFunctionCallRepository = new CallableFunctionCallRepository(CallableFunctionCall);

export default CallableFunctionCall;
