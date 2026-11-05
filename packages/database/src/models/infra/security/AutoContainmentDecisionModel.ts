import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  AUTO_CONTAINMENT_OUTCOMES,
  type AutoContainmentDecisionItem,
  type AutoContainmentOutcome,
} from '@bike4mind/common';

/**
 * Automated containment decisions (contract in b4m-core/common/src/schemas/autoContainment.ts). One
 * document per (detection, revision): that unique pair is what keeps a re-assessed or re-swept
 * detection from being acted on twice.
 */
export interface IAutoContainmentDecisionDocument extends Document {
  detectionId: string;
  revision: number;
  assessmentId: string;
  mode: AutoContainmentDecisionItem['mode'];
  outcome: AutoContainmentOutcome;
  userIds: string[];
  confidence: number;
  reason: string;
  batchId: string | null;
  error: string | null;
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Matches the ShadowDetection retention, so a decision never outlives its detection.
const RETENTION_SECONDS = 365 * 24 * 60 * 60;
const DUPLICATE_KEY = 11000;

export const AutoContainmentDecisionSchema = new Schema<IAutoContainmentDecisionDocument>(
  {
    detectionId: { type: String, required: true },
    revision: { type: Number, required: true },
    assessmentId: { type: String, required: true },
    mode: { type: String, enum: ['shadow', 'enforce'], required: true },
    outcome: { type: String, enum: AUTO_CONTAINMENT_OUTCOMES, required: true },
    userIds: { type: [String], default: [] },
    confidence: { type: Number, required: true },
    reason: { type: String, required: true },
    batchId: { type: String, default: null },
    error: { type: String, default: null },
    decidedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'AutoContainmentDecision' }
);

AutoContainmentDecisionSchema.index({ detectionId: 1, revision: 1 }, { unique: true });
AutoContainmentDecisionSchema.index({ decidedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
AutoContainmentDecisionSchema.index({ outcome: 1, decidedAt: -1 });

export const AutoContainmentDecisionModel: Model<IAutoContainmentDecisionDocument> =
  (mongoose.models.AutoContainmentDecision as unknown as Model<IAutoContainmentDecisionDocument>) ??
  model<IAutoContainmentDecisionDocument>('AutoContainmentDecision', AutoContainmentDecisionSchema);

export type RecordAutoContainmentDecisionInput = Omit<AutoContainmentDecisionItem, 'id'>;

type LeanDecision = Omit<IAutoContainmentDecisionDocument, keyof Document> & { _id: Types.ObjectId };

const toItem = (doc: LeanDecision): AutoContainmentDecisionItem => ({
  id: doc._id.toString(),
  detectionId: doc.detectionId,
  revision: doc.revision,
  assessmentId: doc.assessmentId,
  mode: doc.mode,
  outcome: doc.outcome,
  userIds: [...doc.userIds],
  confidence: doc.confidence,
  reason: doc.reason,
  batchId: doc.batchId,
  error: doc.error,
  decidedAt: doc.decidedAt,
});

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;

export class AutoContainmentDecisionRepository {
  /** Inserts the decision unless the (detection, revision) already has one; null when it does. */
  async recordOnce(input: RecordAutoContainmentDecisionInput): Promise<AutoContainmentDecisionItem | null> {
    try {
      const doc = await AutoContainmentDecisionModel.create(input);
      return toItem(doc.toObject() as unknown as LeanDecision);
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    }
  }

  /**
   * Takes over a decision a run left unfinished: `pending` decided before `staleBefore` (the run died,
   * or its Contain ran out of time budget), or `capped` decided before `cappedBefore` (its hour has
   * reset). Atomic, so of two concurrent runs only one gets it; null when nothing is reclaimable.
   */
  async reclaim(
    id: string,
    {
      staleBefore,
      cappedBefore,
      now,
      mode,
    }: { staleBefore: Date; cappedBefore: Date; now: Date; mode: AutoContainmentDecisionItem['mode'] }
  ): Promise<AutoContainmentDecisionItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await AutoContainmentDecisionModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        $or: [
          { outcome: 'pending', decidedAt: { $lt: staleBefore } },
          { outcome: 'capped', decidedAt: { $lt: cappedBefore } },
        ],
      },
      { $set: { outcome: 'pending', mode, decidedAt: now } },
      { new: true }
    ).lean<LeanDecision>();
    return doc ? toItem(doc) : null;
  }

  /** Records how a claimed decision ended. */
  async finish(id: string, patch: Pick<AutoContainmentDecisionItem, 'outcome' | 'batchId' | 'error'>): Promise<void> {
    await AutoContainmentDecisionModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: patch });
  }

  /** Every decision on the detection, any revision, oldest first. */
  async listForDetection(detectionId: string): Promise<AutoContainmentDecisionItem[]> {
    const docs = await AutoContainmentDecisionModel.find({ detectionId }).sort({ revision: 1 }).lean<LeanDecision[]>();
    return docs.map(toItem);
  }

  /** Decisions since `since`, newest first: the input to shadow grading. */
  async listSince(since: Date, limit: number): Promise<AutoContainmentDecisionItem[]> {
    const docs = await AutoContainmentDecisionModel.find({ decidedAt: { $gte: since } })
      .sort({ decidedAt: -1, _id: -1 })
      .limit(limit)
      .lean<LeanDecision[]>();
    return docs.map(toItem);
  }
}

export const autoContainmentDecisionRepository = new AutoContainmentDecisionRepository();
