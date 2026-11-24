import {
  CALLABLE_FUNCTION_CALL_OPS,
  CALLABLE_FUNCTION_CALL_OUTCOMES,
  CALLABLE_FUNCTION_CALL_SURFACES,
  type ICallableFunctionCall,
  type ICallableFunctionCallDocument,
  type IMongoDocument,
} from '@bike4mind/common';
import mongoose, { Schema, Model, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[a-z0-9_]{1,40}$/;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
  async record(row: ICallableFunctionCall, callId?: string): Promise<ICallableFunctionCallDocument> {
    const id = callId === undefined ? undefined : new mongoose.Types.ObjectId(callId);
    try {
      return await this.create({ ...row, ...(id ? { _id: id } : {}) });
    } catch (error) {
      if (!id || !(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      const keyPattern: unknown = error.keyPattern;
      if (
        keyPattern !== undefined &&
        (!isRecord(keyPattern) || Object.keys(keyPattern).length !== 1 || keyPattern._id !== 1)
      )
        throw error;
      const keyValue: unknown = error.keyValue;
      if (keyValue !== undefined && (!isRecord(keyValue) || String(keyValue._id) !== id.toHexString())) throw error;
      // An insert may commit before its acknowledgement is lost. Reuse that immutable row on retry.
      const existing = await this.findById(id.toHexString());
      if (!existing) throw error;
      return existing;
    }
  }
}

export const callableFunctionCallRepository = new CallableFunctionCallRepository(CallableFunctionCall);

export default CallableFunctionCall;
