import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  ABUSE_ASSESSMENT_FAILURE_CODES,
  ABUSE_ASSESSMENT_JUDGMENTS,
  ABUSE_ASSESSMENT_REASON_KEYS,
  ABUSE_ASSESSMENT_RESULTS,
  ABUSE_ASSESSMENT_TRIGGERS,
  DECISION_MODEL_IDS,
  type AbuseAssessmentFailureCode,
  type AbuseAssessmentFeatureSummary,
  type AbuseAssessmentItem,
  type AbuseAssessmentJudgment,
  type AbuseAssessmentReason,
  type AbuseAssessmentResult,
  type AbuseAssessmentTrigger,
  type DecisionModelId,
} from '@bike4mind/common';

/**
 * Advisory model judgments of shadow detections (contract in
 * b4m-core/common/src/schemas/abuseAssessment.ts). One document per cache key (detection, evidence
 * hash, policy version, model), so a re-run with unchanged evidence reads it instead of calling the
 * provider. Nothing reads this collection to change an account.
 */
export interface IAbuseAssessmentDocument extends Document {
  cacheKey: string;
  detectionId: string;
  result: AbuseAssessmentResult;
  probabilities: { value: AbuseAssessmentJudgment; probability: number }[];
  confidence: number | null;
  // Absent on rows written before policy v2.
  reasons?: AbuseAssessmentReason[];
  // `model` would shadow Document#model.
  decisionModel: DecisionModelId;
  modelVersion: string | null;
  policyVersion: number;
  evidenceVersion: number;
  evidenceHash: string;
  featureSummary: AbuseAssessmentFeatureSummary;
  failure: AbuseAssessmentFailureCode | null;
  attempts: number;
  costUsd: number;
  trigger: AbuseAssessmentTrigger;
  requestedBy: string | null;
  assessedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Matches the ShadowDetection retention, so an assessment never outlives its detection.
const RETENTION_SECONDS = 365 * 24 * 60 * 60;

const ProbabilitySchema = new Schema(
  {
    value: { type: String, enum: ABUSE_ASSESSMENT_JUDGMENTS, required: true },
    probability: { type: Number, required: true },
  },
  { _id: false }
);

const ReasonSchema = new Schema(
  {
    key: { type: String, enum: ABUSE_ASSESSMENT_REASON_KEYS, required: true },
    probability: { type: Number, required: true },
  },
  { _id: false }
);

export const AbuseAssessmentSchema = new Schema<IAbuseAssessmentDocument>(
  {
    cacheKey: { type: String, required: true, unique: true },
    detectionId: { type: String, required: true },
    result: { type: String, enum: ABUSE_ASSESSMENT_RESULTS, required: true },
    probabilities: { type: [ProbabilitySchema], default: [] },
    confidence: { type: Number, default: null },
    reasons: { type: [ReasonSchema], default: undefined },
    decisionModel: { type: String, enum: DECISION_MODEL_IDS, required: true },
    modelVersion: { type: String, default: null },
    policyVersion: { type: Number, required: true },
    evidenceVersion: { type: Number, required: true },
    evidenceHash: { type: String, required: true },
    featureSummary: { type: Schema.Types.Mixed, required: true },
    failure: { type: String, enum: [...ABUSE_ASSESSMENT_FAILURE_CODES, null], default: null },
    attempts: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    trigger: { type: String, enum: ABUSE_ASSESSMENT_TRIGGERS, required: true },
    requestedBy: { type: String, default: null },
    assessedAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false, collection: 'AbuseAssessment' }
);

AbuseAssessmentSchema.index({ assessedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
AbuseAssessmentSchema.index({ detectionId: 1, assessedAt: -1 });

export const AbuseAssessmentModel: Model<IAbuseAssessmentDocument> =
  (mongoose.models.AbuseAssessment as unknown as Model<IAbuseAssessmentDocument>) ??
  model<IAbuseAssessmentDocument>('AbuseAssessment', AbuseAssessmentSchema);

export type SaveAbuseAssessmentInput = Omit<AbuseAssessmentItem, 'id' | 'attempts'> & { cacheKey: string };

type LeanAbuseAssessment = Omit<IAbuseAssessmentDocument, keyof Document> & { _id: Types.ObjectId };

const toItem = (doc: LeanAbuseAssessment): AbuseAssessmentItem => ({
  id: doc._id.toString(),
  detectionId: doc.detectionId,
  result: doc.result,
  probabilities: doc.probabilities.map(({ value, probability }) => ({ value, probability })),
  confidence: doc.confidence,
  reasons: (doc.reasons ?? []).map(({ key, probability }) => ({ key, probability })),
  model: doc.decisionModel,
  modelVersion: doc.modelVersion,
  policyVersion: doc.policyVersion,
  evidenceVersion: doc.evidenceVersion,
  evidenceHash: doc.evidenceHash,
  featureSummary: doc.featureSummary,
  failure: doc.failure,
  attempts: doc.attempts,
  costUsd: doc.costUsd,
  trigger: doc.trigger,
  requestedBy: doc.requestedBy,
  assessedAt: doc.assessedAt,
});

export class AbuseAssessmentRepository {
  async findByCacheKey(cacheKey: string): Promise<AbuseAssessmentItem | null> {
    const doc = await AbuseAssessmentModel.findOne({ cacheKey }).lean<LeanAbuseAssessment>();
    return doc ? toItem(doc) : null;
  }

  /** Writes the latest result for a cache key and counts the attempt; a judgment replaces an unknown. */
  async save(input: SaveAbuseAssessmentInput): Promise<AbuseAssessmentItem> {
    const { cacheKey, model: decisionModel, ...fields } = input;
    const doc = await AbuseAssessmentModel.findOneAndUpdate(
      { cacheKey },
      { $set: { ...fields, decisionModel }, $inc: { attempts: 1 } },
      { upsert: true, new: true, lean: true }
    );
    return toItem(doc as unknown as LeanAbuseAssessment);
  }

  async listForDetection(detectionId: string, limit = 20): Promise<AbuseAssessmentItem[]> {
    const docs = await AbuseAssessmentModel.find({ detectionId })
      .sort({ assessedAt: -1, _id: -1 })
      .limit(limit)
      .lean<LeanAbuseAssessment[]>();
    return docs.map(toItem);
  }
}

export const abuseAssessmentRepository = new AbuseAssessmentRepository();
