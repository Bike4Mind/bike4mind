import mongoose, { Model, Schema } from 'mongoose';
import {
  CreditHolderType,
  GENERATION_JOB_KINDS,
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type IGenerationJob,
  type IGenerationJobDocument,
  type IGenerationJobRepository,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'GenerationJob';

interface IGenerationJobModel extends Model<IGenerationJobDocument> {}

const GenerationJobSchema = new Schema<IGenerationJobDocument>(
  {
    kind: { type: String, enum: [...GENERATION_JOB_KINDS], required: true },
    ownerType: { type: String, enum: [CreditHolderType.User, CreditHolderType.Organization], required: true },
    ownerId: { type: String, required: true },
    requestedBy: { type: String, required: true },
    source: { type: String, enum: [...GENERATION_JOB_SOURCES], required: true },
    state: { type: String, enum: [...GENERATION_JOB_STATES], required: true },
    // Kind-specific; validated by the kind's Zod schemas at the service boundary, not by Mongoose.
    payload: { type: Schema.Types.Mixed, required: true },
    progress: { type: Number },
    pollCount: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    cancelRequested: { type: Boolean, default: false },
    submitAttemptedAt: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    nextPollAt: { type: Date, default: null },
    deadlineAt: { type: Date, required: true },
    idempotencyKey: { type: String },
    creditHold: { type: Schema.Types.Mixed, default: null },
    settledCredits: { type: Number },
    error: new Schema(
      { code: { type: String, required: true }, message: { type: String, required: true } },
      { _id: false }
    ),
    // Raw provider payloads can be large and are never returned to clients.
    rawProviderError: { type: Schema.Types.Mixed, select: false },
    terminalHandlingClaimedAt: { type: Date, default: null },
    terminalHandledAt: { type: Date, default: null },
    questId: { type: String },
  },
  { timestamps: true, versionKey: false, minimize: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Built in production by the ensure-generation-job-indexes migration, not by autoIndex.
GenerationJobSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
GenerationJobSchema.index({ state: 1, nextPollAt: 1 });
GenerationJobSchema.index({ state: 1, terminalHandledAt: 1, updatedAt: 1 });
GenerationJobSchema.index(
  { ownerType: 1, ownerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

export const GenerationJobModel: IGenerationJobModel =
  (mongoose.models[ModelName] as IGenerationJobModel) ||
  mongoose.model<IGenerationJobDocument, IGenerationJobModel>(ModelName, GenerationJobSchema);

const NON_TERMINAL = GENERATION_JOB_STATES.filter(state => !TERMINAL_GENERATION_JOB_STATES.includes(state));
const toJob = (doc: { toJSON(): unknown } | null) => (doc ? (doc.toJSON() as IGenerationJobDocument) : null);

class GenerationJobRepository extends BaseRepository<IGenerationJobDocument> implements IGenerationJobRepository {
  constructor(private jobModel: mongoose.Model<IGenerationJobDocument>) {
    super(jobModel);
  }

  async createJob(input: Omit<IGenerationJob, 'createdAt' | 'updatedAt'>) {
    const doc = await this.jobModel.create(input);
    return doc.toJSON() as IGenerationJobDocument;
  }

  async findByIdempotencyKey(ownerType: IGenerationJob['ownerType'], ownerId: string, key: string) {
    return toJob(await this.jobModel.findOne({ ownerType, ownerId, idempotencyKey: key }));
  }

  // Leasable: unleased (or lease expired) and either still in flight or terminal with handling not done.
  // That includes claimed-but-unhandled terminal jobs: leasing them lets the engine alarm on them,
  // but the claim stays held so settle/release are never re-run.
  async acquireLease(id: string, now: Date, leaseUntil: Date) {
    return toJob(
      await this.jobModel.findOneAndUpdate(
        {
          _id: id,
          $and: [
            { $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] },
            { $or: [{ state: { $in: NON_TERMINAL } }, { terminalHandledAt: null }] },
          ],
        },
        { $set: { leaseUntil } },
        { new: true }
      )
    );
  }

  async markSubmitAttempted(id: string, at: Date) {
    await this.jobModel.updateOne({ _id: id }, { $set: { submitAttemptedAt: at } });
  }

  // Every engine step ends here: one write that applies the step's result and releases the lease.
  // Unfenced: safe only while the lease (330s) outlives the worker Lambda timeout (300s); keep in
  // sync with infra/queues.ts generationJobQueue.
  async commit(id: string, update: GenerationJobCommit) {
    return toJob(
      await this.jobModel.findOneAndUpdate({ _id: id }, { $set: { ...update, leaseUntil: null } }, { new: true })
    );
  }

  async requestCancel(id: string) {
    return toJob(
      await this.jobModel.findOneAndUpdate(
        { _id: id, state: { $in: NON_TERMINAL } },
        { $set: { cancelRequested: true } },
        { new: true }
      )
    );
  }

  async claimTerminalHandling(id: string, at: Date) {
    const result = await this.jobModel.updateOne(
      { _id: id, state: { $in: TERMINAL_GENERATION_JOB_STATES }, terminalHandlingClaimedAt: null },
      { $set: { terminalHandlingClaimedAt: at } }
    );
    return result.modifiedCount === 1;
  }

  async markTerminalHandled(id: string, at: Date) {
    await this.jobModel.updateOne({ _id: id }, { $set: { terminalHandledAt: at } });
  }

  async findStalled(overdueBefore: Date, limit: number) {
    const docs = await this.jobModel
      .find({
        $or: [
          { state: { $in: NON_TERMINAL }, nextPollAt: { $lt: overdueBefore } },
          {
            state: { $in: TERMINAL_GENERATION_JOB_STATES },
            terminalHandledAt: null,
            terminalHandlingClaimedAt: null,
            updatedAt: { $lt: overdueBefore },
          },
          // Claimed long ago and never finished (worker died mid-handling). Re-enqueued only so the
          // engine's stuck path alarms every sweep; onTerminal is never re-run because settle/release
          // are non-idempotent $inc, so this is at-most-once plus an alarm, never a retry.
          {
            state: { $in: TERMINAL_GENERATION_JOB_STATES },
            terminalHandledAt: null,
            terminalHandlingClaimedAt: { $lt: overdueBefore },
          },
        ],
      })
      .limit(limit);
    return docs.map(doc => doc.toJSON() as IGenerationJobDocument);
  }
}

export const generationJobRepository = new GenerationJobRepository(GenerationJobModel);
