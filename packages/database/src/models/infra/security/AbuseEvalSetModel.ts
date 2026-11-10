import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import { SHADOW_DETECTION_VERDICTS, type ShadowDetectionVerdict } from '@bike4mind/common';

export const ABUSE_EVAL_SPLITS = ['tuning', 'heldOut'] as const;
export type AbuseEvalSplit = (typeof ABUSE_EVAL_SPLITS)[number];

export const ABUSE_EVAL_EXAMPLE_KINDS = ['flagged', 'unflagged'] as const;
export type AbuseEvalExampleKind = (typeof ABUSE_EVAL_EXAMPLE_KINDS)[number];

export type AbuseEvalLabel = 'abuse' | 'legit';

export type AbuseEvalFrozenLabel = { label: AbuseEvalLabel; source: string };

/** Append-only: a correction adds an entry, so the history a run was graded from is never rewritten. */
export type AbuseEvalVerdictEntry = {
  verdict: ShadowDetectionVerdict;
  reason: string;
  reviewerId: string;
  reviewedAt: Date;
};

export type AbuseEvalExample = {
  userId: string;
  kind: AbuseEvalExampleKind;
  detectionIds: string[];
  campaignKey: string;
  split: AbuseEvalSplit;
  cohorts: string[];
  signedUpAt: Date | null;
  frozenLabel: AbuseEvalFrozenLabel | null;
  verdicts: AbuseEvalVerdictEntry[];
  revision: number;
};

export type AbuseEvalRun = {
  ranAt: Date;
  ranBy: string;
  note: string | null;
  /** Shape owned by the run grader (apps/client verdictEvalSets schemas); stored whole, never queried. */
  report: unknown;
};

export type AbuseEvalSetItem = {
  id: string;
  name: string;
  note: string | null;
  createdBy: string;
  window: { since: Date; until: Date };
  seed: string;
  heldOutShare: number;
  population: { flagged: number; unflagged: number };
  truncated: boolean;
  examples: AbuseEvalExample[];
  runs: AbuseEvalRun[];
  createdAt: Date;
  updatedAt: Date;
};

export type CreateAbuseEvalSetInput = Omit<AbuseEvalSetItem, 'id' | 'runs' | 'createdAt' | 'updatedAt' | 'examples'> & {
  examples: Array<Omit<AbuseEvalExample, 'verdicts' | 'revision'>>;
};

export type AbuseEvalSetSummary = {
  id: string;
  name: string;
  note: string | null;
  createdBy: string;
  window: { since: Date; until: Date };
  heldOutShare: number;
  population: { flagged: number; unflagged: number };
  truncated: boolean;
  examples: number;
  heldOutExamples: number;
  unflaggedExamples: number;
  /** Examples carrying at least one verdict, by their latest verdict. */
  labelledByVerdict: Record<ShadowDetectionVerdict, number>;
  runs: number;
  lastRunAt: Date | null;
  createdAt: Date;
};

export type AddAbuseEvalExampleVerdictInput = {
  setId: string;
  userId: string;
  expectedRevision: number;
  verdict: ShadowDetectionVerdict;
  reason: string;
  reviewerId: string;
};

export type AddAbuseEvalExampleVerdictResult = 'updated' | 'conflict' | 'not_found' | 'limit_reached';

type MongoExample = Omit<AbuseEvalExample, 'userId' | 'detectionIds' | 'verdicts'> & {
  userId: Types.ObjectId;
  detectionIds: Types.ObjectId[];
  verdicts: Array<Omit<AbuseEvalVerdictEntry, 'reviewerId'> & { reviewerId: Types.ObjectId }>;
};

type MongoRun = Omit<AbuseEvalRun, 'ranBy'> & { ranBy: Types.ObjectId };

export interface IAbuseEvalSetDocument extends Document {
  name: string;
  note: string | null;
  createdBy: Types.ObjectId;
  window: { since: Date; until: Date };
  seed: string;
  heldOutShare: number;
  population: { flagged: number; unflagged: number };
  truncated: boolean;
  examples: MongoExample[];
  runs: MongoRun[];
  createdAt: Date;
  updatedAt: Date;
}

const RETENTION_SECONDS = 365 * 24 * 60 * 60;

/** Newest runs kept per set; older ones are sliced off on append. */
export const ABUSE_EVAL_MAX_RUNS = 50;

/** Verdicts one example may carry; a verdict past it is refused, so the history stays bounded. */
export const ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE = 50;

const VerdictSchema = new Schema(
  {
    verdict: { type: String, enum: SHADOW_DETECTION_VERDICTS, required: true },
    reason: { type: String, required: true },
    reviewerId: { type: Schema.Types.ObjectId, required: true },
    reviewedAt: { type: Date, required: true },
  },
  { _id: false }
);

const FrozenLabelSchema = new Schema(
  {
    label: { type: String, enum: ['abuse', 'legit'], required: true },
    source: { type: String, required: true },
  },
  { _id: false }
);

const ExampleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ABUSE_EVAL_EXAMPLE_KINDS, required: true },
    detectionIds: { type: [Schema.Types.ObjectId], default: [] },
    campaignKey: { type: String, required: true },
    split: { type: String, enum: ABUSE_EVAL_SPLITS, required: true },
    cohorts: { type: [String], default: [] },
    signedUpAt: { type: Date, default: null },
    frozenLabel: { type: FrozenLabelSchema, default: null },
    verdicts: { type: [VerdictSchema], default: [] },
    revision: { type: Number, default: 0 },
  },
  { _id: false }
);

const RunSchema = new Schema(
  {
    ranAt: { type: Date, required: true },
    ranBy: { type: Schema.Types.ObjectId, required: true },
    note: { type: String, default: null },
    report: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

export const AbuseEvalSetSchema: Schema<IAbuseEvalSetDocument> = new Schema<IAbuseEvalSetDocument>(
  {
    name: { type: String, required: true, minlength: 1, maxlength: 120 },
    note: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    window: {
      since: { type: Date, required: true },
      until: { type: Date, required: true },
    },
    seed: { type: String, required: true },
    heldOutShare: { type: Number, required: true },
    population: {
      flagged: { type: Number, required: true },
      unflagged: { type: Number, required: true },
    },
    truncated: { type: Boolean, default: false },
    examples: { type: [ExampleSchema], default: [] },
    runs: { type: [RunSchema], default: [] },
  },
  { timestamps: true, versionKey: false, collection: 'AbuseEvalSet' }
);

// A set lives 365 days from its draw. The detections it references may expire earlier; after that
// their examples abstain in new runs.
AbuseEvalSetSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
AbuseEvalSetSchema.index({ 'examples.userId': 1 });

export const AbuseEvalSetModel: Model<IAbuseEvalSetDocument> =
  (mongoose.models.AbuseEvalSet as unknown as Model<IAbuseEvalSetDocument>) ??
  model<IAbuseEvalSetDocument>('AbuseEvalSet', AbuseEvalSetSchema);

type LeanAbuseEvalSet = Omit<IAbuseEvalSetDocument, keyof Document> & { _id: Types.ObjectId };

const toExample = (example: MongoExample): AbuseEvalExample => ({
  userId: example.userId.toString(),
  kind: example.kind,
  detectionIds: (example.detectionIds ?? []).map(id => id.toString()),
  campaignKey: example.campaignKey,
  split: example.split,
  cohorts: example.cohorts ?? [],
  signedUpAt: example.signedUpAt ?? null,
  frozenLabel: example.frozenLabel ?? null,
  verdicts: (example.verdicts ?? []).map(entry => ({
    verdict: entry.verdict,
    reason: entry.reason,
    reviewerId: entry.reviewerId.toString(),
    reviewedAt: entry.reviewedAt,
  })),
  revision: example.revision ?? 0,
});

const toRun = (run: MongoRun): AbuseEvalRun => ({
  ranAt: run.ranAt,
  ranBy: run.ranBy.toString(),
  note: run.note ?? null,
  report: run.report,
});

const toItem = (doc: LeanAbuseEvalSet): AbuseEvalSetItem => ({
  id: doc._id.toString(),
  name: doc.name,
  note: doc.note ?? null,
  createdBy: doc.createdBy.toString(),
  window: { since: doc.window.since, until: doc.window.until },
  seed: doc.seed,
  heldOutShare: doc.heldOutShare,
  population: { flagged: doc.population.flagged, unflagged: doc.population.unflagged },
  truncated: doc.truncated ?? false,
  examples: (doc.examples ?? []).map(toExample),
  runs: (doc.runs ?? []).map(toRun),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

type SummaryRow = Omit<AbuseEvalSetSummary, 'id' | 'createdBy'> & { _id: Types.ObjectId; createdBy: Types.ObjectId };

const latestVerdictCount = (verdict: ShadowDetectionVerdict) => ({
  $size: {
    $filter: {
      input: '$examples',
      as: 'example',
      cond: { $eq: [{ $arrayElemAt: ['$$example.verdicts.verdict', -1] }, verdict] },
    },
  },
});

class AbuseEvalSetRepository {
  /** Returns the new set's id. Every example starts with no verdicts at revision 0. */
  async create(input: CreateAbuseEvalSetInput): Promise<string> {
    const doc = await AbuseEvalSetModel.create({
      ...input,
      createdBy: new Types.ObjectId(input.createdBy),
      examples: input.examples.map(example => ({
        ...example,
        userId: new Types.ObjectId(example.userId),
        detectionIds: example.detectionIds.map(id => new Types.ObjectId(id)),
        verdicts: [],
        revision: 0,
      })),
      runs: [],
    });
    return doc._id.toString();
  }

  /** Newest first; carries counts only, never the examples or run reports. */
  async list(limit = 50): Promise<AbuseEvalSetSummary[]> {
    const rows = await AbuseEvalSetModel.aggregate<SummaryRow>([
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: limit },
      {
        $project: {
          name: 1,
          note: 1,
          createdBy: 1,
          window: 1,
          heldOutShare: 1,
          population: 1,
          truncated: 1,
          createdAt: 1,
          examples: { $size: '$examples' },
          heldOutExamples: {
            $size: { $filter: { input: '$examples', as: 'example', cond: { $eq: ['$$example.split', 'heldOut'] } } },
          },
          unflaggedExamples: {
            $size: {
              $filter: { input: '$examples', as: 'example', cond: { $eq: ['$$example.kind', 'unflagged'] } },
            },
          },
          labelledByVerdict: Object.fromEntries(
            SHADOW_DETECTION_VERDICTS.map(verdict => [verdict, latestVerdictCount(verdict)])
          ),
          runs: { $size: '$runs' },
          lastRunAt: { $max: '$runs.ranAt' },
        },
      },
    ]).exec();
    return rows.map(({ _id, createdBy, lastRunAt, ...rest }) => ({
      ...rest,
      id: _id.toString(),
      createdBy: createdBy.toString(),
      lastRunAt: lastRunAt ?? null,
    }));
  }

  async findById(id: string): Promise<AbuseEvalSetItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await AbuseEvalSetModel.findById(id).lean<LeanAbuseEvalSet>().exec();
    return doc ? toItem(doc) : null;
  }

  /**
   * Appends a verdict to one example, conditional on the revision the admin saw. 'conflict' means the
   * example exists at another revision; 'limit_reached' means it already carries
   * ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE verdicts; 'not_found' means the set or the example does not exist.
   */
  async addExampleVerdict(input: AddAbuseEvalExampleVerdictInput): Promise<AddAbuseEvalExampleVerdictResult> {
    if (!Types.ObjectId.isValid(input.setId) || !Types.ObjectId.isValid(input.userId)) return 'not_found';
    const setId = new Types.ObjectId(input.setId);
    const userId = new Types.ObjectId(input.userId);
    const result = await AbuseEvalSetModel.updateOne(
      {
        _id: setId,
        examples: {
          $elemMatch: {
            userId,
            // revision counts the verdicts, so this bounds them.
            revision: { $eq: input.expectedRevision, $lt: ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE },
          },
        },
      },
      {
        $push: {
          'examples.$.verdicts': {
            verdict: input.verdict,
            reason: input.reason,
            reviewerId: new Types.ObjectId(input.reviewerId),
            reviewedAt: new Date(),
          },
        },
        $inc: { 'examples.$.revision': 1 },
      }
    );
    if (result.matchedCount === 1) return 'updated';
    const full = await AbuseEvalSetModel.exists({
      _id: setId,
      examples: { $elemMatch: { userId, revision: { $gte: ABUSE_EVAL_MAX_VERDICTS_PER_EXAMPLE } } },
    });
    if (full) return 'limit_reached';
    const exists = await AbuseEvalSetModel.exists({ _id: setId, 'examples.userId': userId });
    return exists ? 'conflict' : 'not_found';
  }

  /** Appends a run, keeping the newest ABUSE_EVAL_MAX_RUNS. Returns the last two runs, oldest first, or null when the set is gone. */
  async appendRun(setId: string, run: AbuseEvalRun): Promise<AbuseEvalRun[] | null> {
    if (!Types.ObjectId.isValid(setId)) return null;
    const updated = await AbuseEvalSetModel.findOneAndUpdate(
      { _id: setId },
      {
        $push: {
          runs: { $each: [{ ...run, ranBy: new Types.ObjectId(run.ranBy) }], $slice: -ABUSE_EVAL_MAX_RUNS },
        },
      },
      { new: true, projection: { runs: { $slice: -2 } } }
    )
      .lean<LeanAbuseEvalSet>()
      .exec();
    return updated ? (updated.runs ?? []).map(toRun) : null;
  }

  /** Account deletion: drops the user's examples from every set. Returns how many sets changed. */
  async removeUser(userId: string): Promise<number> {
    if (!Types.ObjectId.isValid(userId)) return 0;
    const id = new Types.ObjectId(userId);
    const result = await AbuseEvalSetModel.updateMany(
      { 'examples.userId': id },
      { $pull: { examples: { userId: id } } }
    );
    return result.modifiedCount;
  }
}

export const abuseEvalSetRepository = new AbuseEvalSetRepository();
