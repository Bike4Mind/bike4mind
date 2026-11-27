import mongoose, { Model, Schema, model } from 'mongoose';
import { PROBES_TRIGGERS, type ProbesTrigger } from '@bike4mind/common/status';

const ModelName = 'StatusRunState';

export const STATUS_RUN_STATE_ID = 'tick';

const EPOCH_MS = 0;

export type StatusLeaseName = 'probeLease' | 'publishLease';

export interface IStatusLease {
  owner: string;
  until: Date;
}

export interface IStatusRunStateDoc {
  _id: string;
  probeLease: IStatusLease;
  publishLease: IStatusLease;
  seq: number;
  probesAsOf?: Date;
  lastStartedAt?: Date;
  lastFinishedAt?: Date;
  lastError?: string;
  dirtyDays: string[];
  breakglassAppliedSeq: number;
  externalIgnoredUntil?: Date;
  lastExternalSeq?: number;
  lastTrigger?: ProbesTrigger;
  lastScheduledFinishedAt: Date;
  lastManualStartedAt: Date;
  /** Admin-only: never copied into a public file. */
  lastManualActorId?: string;
}

interface IStatusRunStateModel extends Model<IStatusRunStateDoc> {
  /** Creates the single document if missing, with every lease and cooldown field at the epoch. */
  ensureRunState(): Promise<void>;
  /** Takes the lease when it is expired. Null while anyone, the caller included, holds it. */
  acquireLease(lease: StatusLeaseName, owner: string, now: Date, ttlMs: number): Promise<IStatusRunStateDoc | null>;
  /** Frees the lease by moving `until` to the epoch, only where `owner` still holds it. Returns whether it did. */
  releaseLease(lease: StatusLeaseName, owner: string): Promise<boolean>;
}

const LeaseSchema = new Schema(
  {
    owner: { type: String, default: '' },
    until: { type: Date, default: () => new Date(EPOCH_MS) },
  },
  { _id: false }
);

const StatusRunStateSchema = new Schema<IStatusRunStateDoc, IStatusRunStateModel>(
  {
    _id: { type: String },
    probeLease: { type: LeaseSchema },
    publishLease: { type: LeaseSchema },
    seq: { type: Number },
    probesAsOf: { type: Date },
    lastStartedAt: { type: Date },
    lastFinishedAt: { type: Date },
    lastError: { type: String },
    dirtyDays: { type: [String] },
    breakglassAppliedSeq: { type: Number },
    externalIgnoredUntil: { type: Date },
    lastExternalSeq: { type: Number },
    lastTrigger: { type: String, enum: PROBES_TRIGGERS },
    lastScheduledFinishedAt: { type: Date },
    lastManualStartedAt: { type: Date },
    lastManualActorId: { type: String },
  },
  { collection: 'statusRunState' }
);

StatusRunStateSchema.static('ensureRunState', async function ensureRunState(this: IStatusRunStateModel) {
  const epoch = new Date(EPOCH_MS);
  try {
    await this.updateOne(
      { _id: STATUS_RUN_STATE_ID },
      {
        $setOnInsert: {
          probeLease: { owner: '', until: epoch },
          publishLease: { owner: '', until: epoch },
          seq: 0,
          dirtyDays: [],
          breakglassAppliedSeq: 0,
          lastScheduledFinishedAt: epoch,
          lastManualStartedAt: epoch,
        },
      },
      { upsert: true, runValidators: true }
    );
  } catch (error) {
    // Two upserts racing on the same _id: the loser's insert hits the winner's document.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
});

StatusRunStateSchema.static(
  'acquireLease',
  async function acquireLease(
    this: IStatusRunStateModel,
    lease: StatusLeaseName,
    owner: string,
    now: Date,
    ttlMs: number
  ) {
    if (!owner) throw new Error('A lease owner must be a non-empty string');
    return this.findOneAndUpdate(
      { _id: STATUS_RUN_STATE_ID, [`${lease}.until`]: { $lt: now } },
      { $set: { [lease]: { owner, until: new Date(now.getTime() + ttlMs) } } },
      { new: true, runValidators: true }
    ).lean<IStatusRunStateDoc>();
  }
);

StatusRunStateSchema.static(
  'releaseLease',
  async function releaseLease(this: IStatusRunStateModel, lease: StatusLeaseName, owner: string) {
    const result = await this.updateOne(
      { _id: STATUS_RUN_STATE_ID, [`${lease}.owner`]: owner },
      { $set: { [`${lease}.until`]: new Date(EPOCH_MS) } },
      { runValidators: true }
    );
    return result.modifiedCount > 0;
  }
);

export const StatusRunState: IStatusRunStateModel =
  (mongoose.models[ModelName] as unknown as IStatusRunStateModel) ||
  model<IStatusRunStateDoc, IStatusRunStateModel>(ModelName, StatusRunStateSchema);
