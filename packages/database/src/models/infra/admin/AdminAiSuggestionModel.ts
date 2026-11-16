import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  ADMIN_AI_CONFIDENCE_BANDS,
  ADMIN_AI_FEATURES,
  ADMIN_AI_MAX_EVIDENCE_LINKS,
  ADMIN_AI_MAX_OVERRIDE_REASON_CHARS,
  ADMIN_AI_MAX_REASON_CHARS,
  ADMIN_AI_MAX_REASONS,
  ADMIN_AI_SUGGESTION_STATUSES,
  type AdminAiConfidenceBand,
  type AdminAiFeature,
  type AdminAiReason,
  type AdminAiSuggestionItem,
  type AdminAiSuggestionStatus,
} from '@bike4mind/common';

/**
 * Advisory admin AI suggestions (contract in b4m-core/common/src/schemas/adminAi.ts). The unique
 * (feature, entityId, inputHash, policyVersion) key is the dedup the runner relies on: unchanged
 * input under the same policy reads the stored row instead of calling the provider again.
 */
export interface IAdminAiSuggestionDocument extends Document {
  feature: AdminAiFeature;
  entityType: string;
  entityId: string;
  inputHash: string;
  policyVersion: string;
  actionClass?: string;
  overrideCostly?: boolean | null;
  costUnknown?: boolean;
  // `model` would shadow Document#model.
  aiModel: string;
  escalated: boolean;
  verdict: string;
  confidence: { band: AdminAiConfidenceBand; probability: number };
  reasons: AdminAiReason[];
  proposedAction: unknown;
  status: AdminAiSuggestionStatus;
  decidedBy: { userId: string; name: string } | null;
  decidedAt: Date | null;
  overrideAction: unknown;
  overrideReason: string | null;
  costUsd: number;
  latencyMs: number;
  createdAt: Date;
  updatedAt: Date;
}

const ReasonSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: ADMIN_AI_MAX_REASON_CHARS },
    evidenceLinks: {
      type: [String],
      default: [],
      validate: {
        validator: (links: string[]) => links.length <= ADMIN_AI_MAX_EVIDENCE_LINKS,
        message: `at most ${ADMIN_AI_MAX_EVIDENCE_LINKS} evidence links`,
      },
    },
  },
  { _id: false }
);

export const AdminAiSuggestionSchema: Schema<IAdminAiSuggestionDocument> = new Schema<IAdminAiSuggestionDocument>(
  {
    feature: { type: String, enum: ADMIN_AI_FEATURES, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    inputHash: { type: String, required: true },
    policyVersion: { type: String, required: true },
    actionClass: String,
    overrideCostly: { type: Boolean, default: null },
    costUnknown: { type: Boolean, default: false },
    aiModel: { type: String, required: true },
    escalated: { type: Boolean, default: false },
    verdict: { type: String, required: true },
    confidence: {
      band: { type: String, enum: ADMIN_AI_CONFIDENCE_BANDS, required: true },
      probability: { type: Number, required: true, min: 0, max: 1 },
    },
    reasons: {
      type: [ReasonSchema],
      default: [],
      validate: {
        validator: (reasons: unknown[]) => reasons.length <= ADMIN_AI_MAX_REASONS,
        message: `at most ${ADMIN_AI_MAX_REASONS} reasons`,
      },
    },
    proposedAction: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: ADMIN_AI_SUGGESTION_STATUSES, default: 'pending', required: true },
    decidedBy: {
      type: new Schema(
        { userId: { type: String, required: true }, name: { type: String, required: true } },
        { _id: false }
      ),
      default: null,
    },
    decidedAt: { type: Date, default: null },
    overrideAction: { type: Schema.Types.Mixed, default: null },
    overrideReason: { type: String, default: null, maxlength: ADMIN_AI_MAX_OVERRIDE_REASON_CHARS },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'AdminAiSuggestion' }
);

AdminAiSuggestionSchema.index({ feature: 1, entityId: 1, inputHash: 1, policyVersion: 1 }, { unique: true });
AdminAiSuggestionSchema.index({ feature: 1, status: 1, createdAt: -1 });
AdminAiSuggestionSchema.index({ feature: 1, actionClass: 1, policyVersion: 1, status: 1, decidedAt: -1 });
AdminAiSuggestionSchema.index({ status: 1, decidedAt: -1 });
AdminAiSuggestionSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
AdminAiSuggestionSchema.index({ feature: 1, entityId: 1, createdAt: -1, _id: -1 });

export const AdminAiSuggestionModel: Model<IAdminAiSuggestionDocument> =
  (mongoose.models.AdminAiSuggestion as unknown as Model<IAdminAiSuggestionDocument>) ??
  model<IAdminAiSuggestionDocument>('AdminAiSuggestion', AdminAiSuggestionSchema);

export type AdminAiSuggestionKey = Pick<AdminAiSuggestionItem, 'feature' | 'entityId' | 'inputHash' | 'policyVersion'>;

export type CreatePendingAdminAiSuggestionInput = AdminAiSuggestionKey &
  Pick<AdminAiSuggestionItem, 'entityType' | 'model' | 'verdict' | 'confidence' | 'reasons' | 'costUsd' | 'latencyMs'> &
  Partial<Pick<AdminAiSuggestionItem, 'escalated' | 'proposedAction' | 'actionClass' | 'costUnknown'>>;

export type AdminAiSuggestionDecision = {
  decidedBy?: { userId: string; name: string } | null;
  overrideAction?: unknown;
  overrideReason?: string | null;
  overrideCostly?: boolean | null;
};

type LeanAdminAiSuggestion = Omit<IAdminAiSuggestionDocument, keyof Document> & { _id: Types.ObjectId };

const DUPLICATE_KEY = 11000;

const toItem = (doc: LeanAdminAiSuggestion): AdminAiSuggestionItem => ({
  id: doc._id.toString(),
  feature: doc.feature,
  entityType: doc.entityType,
  entityId: doc.entityId,
  inputHash: doc.inputHash,
  policyVersion: doc.policyVersion,
  actionClass: doc.actionClass,
  overrideCostly: doc.overrideCostly,
  costUnknown: doc.costUnknown,
  model: doc.aiModel,
  escalated: doc.escalated,
  verdict: doc.verdict,
  confidence: { band: doc.confidence.band, probability: doc.confidence.probability },
  reasons: doc.reasons.map(({ text, evidenceLinks }) => ({ text, evidenceLinks: [...evidenceLinks] })),
  proposedAction: doc.proposedAction ?? null,
  status: doc.status,
  decidedBy: doc.decidedBy ? { userId: doc.decidedBy.userId, name: doc.decidedBy.name } : null,
  decidedAt: doc.decidedAt ?? null,
  overrideAction: doc.overrideAction ?? null,
  overrideReason: doc.overrideReason ?? null,
  costUsd: doc.costUsd,
  latencyMs: doc.latencyMs,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;

export class AdminAiSuggestionRepository {
  async findByKey(key: AdminAiSuggestionKey): Promise<AdminAiSuggestionItem | null> {
    const { feature, entityId, inputHash, policyVersion } = key;
    const doc = await AdminAiSuggestionModel.findOne({
      feature,
      entityId,
      inputHash,
      policyVersion,
    }).lean<LeanAdminAiSuggestion>();
    return doc ? toItem(doc) : null;
  }

  /** Stores a pending suggestion; when another writer already stored this key, returns that row instead. */
  async createPending(input: CreatePendingAdminAiSuggestionInput): Promise<AdminAiSuggestionItem> {
    const { model: aiModel, ...fields } = input;
    // One retry: the conflicting row can vanish between the duplicate-key error and the read.
    for (let attempt = 0; ; attempt++) {
      try {
        const doc = await AdminAiSuggestionModel.create({ ...fields, aiModel, status: 'pending' });
        return toItem(doc.toObject() as unknown as LeanAdminAiSuggestion);
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await this.findByKey(input);
        if (existing) return existing;
        if (attempt >= 1) throw error;
      }
    }
  }

  /** Rows for any of these (entityId, inputHash) pairs, across policy versions; may over-match pairs. */
  async findForEntities(
    feature: AdminAiFeature,
    keys: { entityId: string; inputHash: string }[]
  ): Promise<AdminAiSuggestionItem[]> {
    if (keys.length === 0) return [];
    const docs = await AdminAiSuggestionModel.find({
      feature,
      entityId: { $in: [...new Set(keys.map(key => key.entityId))] },
      inputHash: { $in: [...new Set(keys.map(key => key.inputHash))] },
    }).lean<LeanAdminAiSuggestion[]>();
    return docs.map(toItem);
  }

  async findLatestForEntity(feature: AdminAiFeature, entityId: string): Promise<AdminAiSuggestionItem | null> {
    const doc = await AdminAiSuggestionModel.findOne({ feature, entityId })
      .sort({ createdAt: -1, _id: -1 })
      .lean<LeanAdminAiSuggestion>();
    return doc ? toItem(doc) : null;
  }

  /**
   * Moves a suggestion to `to` only while its status is still one of `from`, so a second accept of the
   * same row returns null instead of applying twice. Also null for an id that is not an ObjectId.
   */
  async transition(
    id: string,
    from: readonly AdminAiSuggestionStatus[],
    to: AdminAiSuggestionStatus,
    decision: AdminAiSuggestionDecision = {}
  ): Promise<AdminAiSuggestionItem | null> {
    if (!Types.ObjectId.isValid(id) || String(new Types.ObjectId(id)) !== id.toLowerCase()) return null;
    const set: Record<string, unknown> = { status: to, decidedAt: new Date() };
    if (decision.decidedBy !== undefined) set.decidedBy = decision.decidedBy;
    if (decision.overrideAction !== undefined) set.overrideAction = decision.overrideAction;
    if (decision.overrideReason !== undefined) set.overrideReason = decision.overrideReason;
    if (decision.overrideCostly !== undefined) set.overrideCostly = decision.overrideCostly;
    const doc = await AdminAiSuggestionModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), status: { $in: [...from] } },
      { $set: set },
      { new: true, runValidators: true, lean: true }
    );
    return doc ? toItem(doc as unknown as LeanAdminAiSuggestion) : null;
  }
}

export const adminAiSuggestionRepository = new AdminAiSuggestionRepository();
