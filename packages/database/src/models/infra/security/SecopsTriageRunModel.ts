import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';

export type SecopsTriageRunStatus = 'completed' | 'failed' | 'skipped';

export interface SecopsTriageRunCounts {
  created: number;
  updated: number;
  reopened: number;
  closed: number;
  suppressed: number;
  belowThreshold: number;
  overCap: number;
}

export interface SecopsTriageRunItem {
  id: string;
  stage: string;
  scanSource: string;
  status: SecopsTriageRunStatus;
  /** Why a run was skipped: 'disabled', 'invalid_config', 'no_github_connection' or a repository check reason. */
  reason?: string;
  dryRun: boolean;
  findingCount: number;
  counts?: SecopsTriageRunCounts;
  error?: string;
  startedAt: Date;
  durationMs?: number;
}

export type RecordSecopsTriageRunInput = Omit<SecopsTriageRunItem, 'id'>;

/** One document per SecOps triage worker invocation, read by the admin status endpoint. */
export interface ISecopsTriageRunDocument extends Document {
  stage: string;
  scanSource: string;
  status: SecopsTriageRunStatus;
  reason?: string;
  dryRun: boolean;
  findingCount: number;
  counts?: SecopsTriageRunCounts;
  error?: string;
  startedAt: Date;
  durationMs?: number;
  createdAt: Date;
  updatedAt: Date;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;
const ERROR_MAX_LENGTH = 500;

const CountsSchema = new Schema<SecopsTriageRunCounts>(
  {
    created: { type: Number, required: true },
    updated: { type: Number, required: true },
    reopened: { type: Number, required: true },
    closed: { type: Number, required: true },
    suppressed: { type: Number, required: true },
    belowThreshold: { type: Number, required: true },
    overCap: { type: Number, required: true },
  },
  { _id: false }
);

export const SecopsTriageRunSchema: Schema<ISecopsTriageRunDocument> = new Schema<ISecopsTriageRunDocument>(
  {
    stage: { type: String, required: true },
    scanSource: { type: String, required: true },
    status: { type: String, enum: ['completed', 'failed', 'skipped'], required: true },
    reason: { type: String, required: false },
    dryRun: { type: Boolean, required: true },
    findingCount: { type: Number, required: true },
    counts: { type: CountsSchema, required: false },
    error: { type: String, required: false },
    startedAt: { type: Date, required: true },
    durationMs: { type: Number, required: false },
  },
  { timestamps: true, versionKey: false }
);

SecopsTriageRunSchema.index({ stage: 1, startedAt: -1 });
SecopsTriageRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const SecopsTriageRunModel: Model<ISecopsTriageRunDocument> =
  (mongoose.models.SecopsTriageRun as unknown as Model<ISecopsTriageRunDocument>) ??
  model<ISecopsTriageRunDocument>('SecopsTriageRun', SecopsTriageRunSchema);

type LeanRun = Omit<ISecopsTriageRunDocument, keyof Document> & { _id: Types.ObjectId };

const toItem = (doc: LeanRun): SecopsTriageRunItem => ({
  id: doc._id.toString(),
  stage: doc.stage,
  scanSource: doc.scanSource,
  status: doc.status,
  ...(doc.reason ? { reason: doc.reason } : {}),
  dryRun: doc.dryRun,
  findingCount: doc.findingCount,
  ...(doc.counts
    ? {
        counts: {
          created: doc.counts.created,
          updated: doc.counts.updated,
          reopened: doc.counts.reopened,
          closed: doc.counts.closed,
          suppressed: doc.counts.suppressed,
          belowThreshold: doc.counts.belowThreshold,
          overCap: doc.counts.overCap,
        },
      }
    : {}),
  ...(doc.error ? { error: doc.error } : {}),
  startedAt: doc.startedAt,
  ...(typeof doc.durationMs === 'number' ? { durationMs: doc.durationMs } : {}),
});

export class SecopsTriageRunRepository {
  async record(input: RecordSecopsTriageRunInput): Promise<SecopsTriageRunItem> {
    const doc = await SecopsTriageRunModel.create({
      ...input,
      ...(input.error !== undefined ? { error: input.error.slice(0, ERROR_MAX_LENGTH) } : {}),
    });
    return toItem(doc.toObject() as unknown as LeanRun);
  }

  /** The stage's most recent runs, newest first. */
  async findRecentByStage(stage: string, limit = 10): Promise<SecopsTriageRunItem[]> {
    const docs = await SecopsTriageRunModel.find({ stage })
      .sort({ startedAt: -1, _id: -1 })
      .limit(limit)
      .lean<LeanRun[]>();
    return docs.map(toItem);
  }

  /** The stage's newest run of each scan source, newest first. */
  async findLatestPerSourceByStage(stage: string): Promise<SecopsTriageRunItem[]> {
    const docs = await SecopsTriageRunModel.aggregate<LeanRun>([
      { $match: { stage } },
      // startedAt alone, so the { stage, startedAt } index serves this sort without an in-memory one.
      { $sort: { startedAt: -1 } },
      { $group: { _id: '$scanSource', run: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$run' } },
      { $sort: { startedAt: -1, _id: -1 } },
    ]);
    return docs.map(toItem);
  }
}

export const secopsTriageRunRepository = new SecopsTriageRunRepository();
