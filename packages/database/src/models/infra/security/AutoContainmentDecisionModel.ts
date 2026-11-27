import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import {
  ABUSE_ASSESSMENT_RESULTS,
  AUTO_CONTAINMENT_OUTCOMES,
  INTERVENTION_DECIDERS,
  LINK_RULES,
  INTERVENTION_RELEASE_CONDITIONS,
  INTERVENTION_SCOPES,
  INTERVENTION_TIERS,
  type AutoContainmentDecisionItem,
  type AutoContainmentOutcome,
  type InterventionDecider,
  type InterventionReleaseCondition,
  type LinkRule,
  type InterventionScope,
  type InterventionTier,
} from '@bike4mind/common';

/**
 * Automated containment decisions (contract in b4m-core/common/src/schemas/autoContainment.ts). One
 * graduated claim and one independent Contain claim per detection revision. The shared graduated
 * claim keeps concurrent tier choices from stacking.
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
  tier?: InterventionTier;
  /** Internal write fence shared by hold application and committed containment receipts. */
  holdWriteVersion?: number;
  /** Null also covers pre-tier writers that omit this field in the compound unique index. */
  claimClass?: 'graduated' | null;
  containedUserIds?: string[];
  policyVersion?: number | null;
  scope?: InterventionScope;
  expiresAt?: Date | null;
  releaseCondition?: InterventionReleaseCondition | null;
  releasedAt?: Date | null;
  releasedBy?: string | null;
  releaseReason?: string | null;
  decidedBy?: InterventionDecider;
  linkRules?: LinkRule[];
  modelJudgment?: AutoContainmentDecisionItem['modelJudgment'];
  createdAt: Date;
  updatedAt: Date;
}

// Matches the ShadowDetection retention, so a decision never outlives its detection.
const RETENTION_SECONDS = 365 * 24 * 60 * 60;
const DUPLICATE_KEY = 11000;
const claimClassOf = (tier: InterventionTier): 'graduated' | null => (tier === 'contain' ? null : 'graduated');

export const AutoContainmentDecisionSchema: Schema<IAutoContainmentDecisionDocument> =
  new Schema<IAutoContainmentDecisionDocument>(
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
      tier: { type: String, enum: INTERVENTION_TIERS, default: 'contain' },
      claimClass: {
        type: String,
        enum: ['graduated', null],
        default: function (this: IAutoContainmentDecisionDocument) {
          return claimClassOf(this.tier ?? 'contain');
        },
      },
      holdWriteVersion: { type: Number, default: 0 },
      containedUserIds: { type: [String], default: [] },
      policyVersion: { type: Number, default: null },
      scope: { type: String, enum: INTERVENTION_SCOPES, default: 'account' },
      expiresAt: { type: Date, default: null },
      releaseCondition: { type: String, enum: [...INTERVENTION_RELEASE_CONDITIONS, null], default: null },
      releasedAt: { type: Date, default: null },
      releasedBy: { type: String, default: null },
      releaseReason: { type: String, default: null },
      decidedBy: { type: String, enum: INTERVENTION_DECIDERS, default: 'model' },
      linkRules: { type: [{ type: String, enum: LINK_RULES }], default: [] },
      modelJudgment: {
        type: new Schema(
          {
            result: { type: String, enum: ABUSE_ASSESSMENT_RESULTS, required: true },
            confidence: { type: Number, default: null },
          },
          { _id: false }
        ),
        default: null,
      },
    },
    { timestamps: true, versionKey: false, collection: 'AutoContainmentDecision' }
  );

/** Graduated decisions whose holds may be on accounts: a failed one can have applied some before it failed. */
const HOLDING_FILTER = {
  tier: { $in: INTERVENTION_TIERS.filter(tier => tier !== 'contain') },
  outcome: { $in: ['intervened', 'failed'] },
};

AutoContainmentDecisionSchema.index(
  { detectionId: 1, revision: 1, claimClass: 1 },
  { unique: true, name: 'detection_revision_claim_class_unique' }
);
AutoContainmentDecisionSchema.index({ decidedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
AutoContainmentDecisionSchema.index({ outcome: 1, decidedAt: -1 });

export const AutoContainmentDecisionModel: Model<IAutoContainmentDecisionDocument> =
  (mongoose.models.AutoContainmentDecision as unknown as Model<IAutoContainmentDecisionDocument>) ??
  model<IAutoContainmentDecisionDocument>('AutoContainmentDecision', AutoContainmentDecisionSchema);

type DecisionTierField =
  | 'tier'
  | 'policyVersion'
  | 'scope'
  | 'expiresAt'
  | 'releaseCondition'
  | 'releasedAt'
  | 'releasedBy'
  | 'releaseReason'
  | 'decidedBy'
  | 'linkRules'
  | 'modelJudgment';

/** The tier fields are optional so the Contain path records exactly what it did before tiers existed. */
export type RecordAutoContainmentDecisionInput = Omit<AutoContainmentDecisionItem, 'id' | DecisionTierField> &
  Partial<Pick<AutoContainmentDecisionItem, DecisionTierField>>;

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
  tier: doc.tier ?? 'contain',
  policyVersion: doc.policyVersion ?? null,
  scope: doc.scope ?? 'account',
  expiresAt: doc.expiresAt ?? null,
  releaseCondition: doc.releaseCondition ?? null,
  releasedAt: doc.releasedAt ?? null,
  releasedBy: doc.releasedBy ?? null,
  releaseReason: doc.releaseReason ?? null,
  decidedBy: doc.decidedBy ?? 'model',
  linkRules: [...(doc.linkRules ?? [])],
  modelJudgment: doc.modelJudgment
    ? { result: doc.modelJudgment.result, confidence: doc.modelJudgment.confidence ?? null }
    : null,
});

const isDuplicateKey = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === DUPLICATE_KEY;

export class AutoContainmentDecisionRepository {
  /** Inserts the decision unless the revision already has a claim of this class; null when it does. */
  async recordOnce(input: RecordAutoContainmentDecisionInput): Promise<AutoContainmentDecisionItem | null> {
    if (!Types.ObjectId.isValid(input.detectionId)) return null;
    try {
      return await withTransaction(async session => {
        // This parent write serializes new claims, including an insert delayed behind Contain cleanup.
        // update-validators-off: native driver increments only the declared internal counter; preserves domain timestamps/revision
        const parent = await mongoose.connection
          .collection('ShadowDetection')
          .updateOne({ _id: new Types.ObjectId(input.detectionId) }, { $inc: { holdClaimVersion: 1 } }, { session });
        if (parent.matchedCount !== 1) return null;
        const tier = input.tier ?? 'contain';
        const prior = await AutoContainmentDecisionModel.find({ detectionId: input.detectionId })
          .session(session)
          .lean<LeanDecision[]>();
        const covering = tier === 'contain' ? prior.filter(row => (row.tier ?? 'contain') === 'contain') : prior;
        const covered = new Set(covering.flatMap(row => row.userIds));
        const userIds = input.userIds.filter(userId => !covered.has(userId));
        if (userIds.length === 0) return null;
        const [doc] = await AutoContainmentDecisionModel.create(
          [{ ...input, userIds, tier, claimClass: claimClassOf(tier) }],
          { session }
        );
        return toItem(doc.toObject() as unknown as LeanDecision);
      });
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

  /** Records how this specific claim ended; a released or reclaimed claim cannot be overwritten. */
  async finish(
    id: string,
    patch: Pick<AutoContainmentDecisionItem, 'outcome' | 'batchId' | 'error'>,
    decidedAt: Date
  ): Promise<boolean> {
    const result = await AutoContainmentDecisionModel.updateOne(
      { _id: new Types.ObjectId(id), outcome: 'pending', decidedAt },
      { $set: patch },
      { runValidators: true }
    );
    return result.matchedCount === 1;
  }

  /**
   * Marks an applied graduated hold released. Only a graduated decision that applied holds (`intervened`,
   * or `failed` after applying some) and is not yet released moves,
   * so a repeat or a release racing expiry is a no-op; null when nothing changed.
   */
  async release(
    id: string,
    { by, reason, condition, now }: { by: string; reason: string; condition: InterventionReleaseCondition; now: Date }
  ): Promise<AutoContainmentDecisionItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await AutoContainmentDecisionModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), ...HOLDING_FILTER, releasedAt: null },
      {
        $set: {
          outcome: 'released',
          releasedAt: now,
          releasedBy: by,
          releaseReason: reason,
          releaseCondition: condition,
        },
      },
      { new: true, runValidators: true }
    ).lean<LeanDecision>();
    return doc ? toItem(doc) : null;
  }

  /** Stamps applied, unreleased graduated decisions as expired; returns how many moved. */
  async markExpired(ids: string[], now: Date): Promise<number> {
    const objectIds = ids.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id));
    if (objectIds.length === 0) return 0;
    const result = await AutoContainmentDecisionModel.updateMany(
      { _id: { $in: objectIds }, ...HOLDING_FILTER, releasedAt: null, expiresAt: { $ne: null, $lte: now } },
      { $set: { outcome: 'expired', releasedAt: now, releaseCondition: 'expiry' } },
      { runValidators: true }
    );
    return result.modifiedCount;
  }

  async findById(id: string): Promise<AutoContainmentDecisionItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const doc = await AutoContainmentDecisionModel.findById(id).lean<LeanDecision>();
    return doc ? toItem(doc) : null;
  }

  /** Applied graduated decisions of one tier not yet released, oldest first (bulk rollback). */
  async listActiveByTier(tier: InterventionTier, limit: number): Promise<AutoContainmentDecisionItem[]> {
    const docs = await AutoContainmentDecisionModel.find({ ...HOLDING_FILTER, tier, releasedAt: null })
      .sort({ _id: 1 })
      .limit(limit)
      .lean<LeanDecision[]>();
    return docs.map(toItem);
  }

  /** Every decision on the detection, any revision, oldest first. */
  async listForDetection(detectionId: string): Promise<AutoContainmentDecisionItem[]> {
    const docs = await AutoContainmentDecisionModel.find({ detectionId })
      .sort({ revision: 1, _id: 1 })
      .lean<LeanDecision[]>();
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
