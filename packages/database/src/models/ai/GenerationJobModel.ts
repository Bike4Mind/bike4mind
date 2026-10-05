import mongoose, { Model, Schema } from 'mongoose';
import {
  CreditHolderType,
  GENERATION_JOB_ID_PATTERN,
  GENERATION_JOB_KINDS,
  GENERATION_JOB_SOURCES,
  GENERATION_JOB_STATES,
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type GenerationJobCommitGuard,
  type GenerationJobCreateInput,
  type GenerationJobState,
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
// Storing is excluded: the provider already produced (and billed) the output, so a cancel saves nothing.
const CANCELLABLE: GenerationJobState[] = ['pending', 'running'];
const toJob = (doc: { toJSON(): unknown } | null) => (doc ? (doc.toJSON() as IGenerationJobDocument) : null);
const unleased = (now: Date) => ({ $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] });

const commitGuardFilter = (guard: GenerationJobCommitGuard) =>
  guard.kind === 'lease'
    ? { leaseUntil: guard.leaseToken }
    : { state: 'pending', submitAttemptedAt: null, ...unleased(guard.now) };

class GenerationJobRepository extends BaseRepository<IGenerationJobDocument> implements IGenerationJobRepository {
  constructor(private jobModel: mongoose.Model<IGenerationJobDocument>) {
    super(jobModel);
  }

  async createJob({ id, ...input }: GenerationJobCreateInput) {
    if (id !== undefined && !GENERATION_JOB_ID_PATTERN.test(id)) {
      throw new Error(`generation job id must be a lowercase 24-hex ObjectId string, got '${id}'`);
    }
    const doc = await this.jobModel.create(id === undefined ? input : { ...input, _id: id });
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
          $and: [unleased(now), { $or: [{ state: { $in: NON_TERMINAL } }, { terminalHandledAt: null }] }],
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
  async commit(id: string, update: GenerationJobCommit, guard: GenerationJobCommitGuard) {
    return toJob(
      await this.jobModel.findOneAndUpdate(
        { _id: id, ...commitGuardFilter(guard) },
        { $set: { ...update, leaseUntil: null } },
        { new: true }
      )
    );
  }

  async requestCancel(id: string) {
    return toJob(
      await this.jobModel.findOneAndUpdate(
        { _id: id, state: { $in: CANCELLABLE } },
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

  async recordSettlement(id: string, settledCredits: number) {
    await this.jobModel.updateOne({ _id: id }, { $set: { settledCredits } });
  }

  /**
   * Oldest first: in-flight jobs by nextPollAt, then terminal jobs by updatedAt. Two queries because Mongo sorts a
   * null nextPollAt (every terminal job) first. A stuck-claimed terminal job matches every sweep forever, so it must
   * never crowd out real recovery; each sweep's lease bumps its updatedAt, which also rotates it behind older ones.
   * Served by the { state, nextPollAt } and { state, terminalHandledAt, updatedAt } indexes.
   */
  async findStalled(overdueBefore: Date, limit: number) {
    const inFlight = await this.jobModel
      .find({ state: { $in: NON_TERMINAL }, nextPollAt: { $lt: overdueBefore } })
      .sort({ nextPollAt: 1 })
      .limit(limit);
    const remaining = limit - inFlight.length;
    const terminal =
      remaining > 0
        ? await this.jobModel
            .find({
              state: { $in: TERMINAL_GENERATION_JOB_STATES },
              terminalHandledAt: null,
              $or: [
                { terminalHandlingClaimedAt: null, updatedAt: { $lt: overdueBefore } },
                // Claimed long ago and never finished (worker died mid-handling). Re-enqueued only so the
                // engine's stuck path alarms every sweep; onTerminal is never re-run because settle/release
                // are non-idempotent $inc, so this is at-most-once plus an alarm, never a retry.
                { terminalHandlingClaimedAt: { $lt: overdueBefore } },
              ],
            })
            .sort({ updatedAt: 1 })
            .limit(remaining)
        : [];
    return [...inFlight, ...terminal].map(doc => doc.toJSON() as IGenerationJobDocument);
  }
}

export const generationJobRepository = new GenerationJobRepository(GenerationJobModel);
