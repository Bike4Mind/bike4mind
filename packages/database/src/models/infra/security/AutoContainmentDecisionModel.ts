import mongoose, { Document, Model, model, Schema, Types } from 'mongoose';
import {
  AUTO_CONTAINMENT_OUTCOMES,
  INTERVENTION_RELEASE_CONDITIONS,
  INTERVENTION_SCOPES,
  INTERVENTION_TIERS,
  type AutoContainmentDecisionItem,
  type AutoContainmentOutcome,
  type InterventionReleaseCondition,
  type InterventionScope,
  type InterventionTier,
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
  tier?: InterventionTier;
  policyVersion?: number | null;
  scope?: InterventionScope;
  expiresAt?: Date | null;
  releaseCondition?: InterventionReleaseCondition | null;
  releasedAt?: Date | null;
  releasedBy?: string | null;
  releaseReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Matches the ShadowDetection retention, so a decision never outlives its detection.
const RETENTION_SECONDS = 365 * 24 * 60 * 60;
const DUPLICATE_KEY = 11000;

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
      policyVersion: { type: Number, default: null },
      scope: { type: String, enum: INTERVENTION_SCOPES, default: 'account' },
      expiresAt: { type: Date, default: null },
      releaseCondition: { type: String, enum: [...INTERVENTION_RELEASE_CONDITIONS, null], default: null },
      releasedAt: { type: Date, default: null },
      releasedBy: { type: String, default: null },
      releaseReason: { type: String, default: null },
    },
    { timestamps: true, versionKey: false, collection: 'AutoContainmentDecision' }
  );

/** Graduated decisions whose holds may be on accounts: a failed one can have applied some before it failed. */
const HOLDING_FILTER = {
  tier: { $in: INTERVENTION_TIERS.filter(tier => tier !== 'contain') },
  outcome: { $in: ['intervened', 'failed'] },
};

AutoContainmentDecisionSchema.index({ detectionId: 1, revision: 1 }, { unique: true });
AutoContainmentDecisionSchema.index({ decidedAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
AutoContainmentDecisionSchema.index({ outcome: 1, decidedAt: -1 });

export const AutoContainmentDecisionModel: Model<IAutoContainmentDecisionDocument> =
  (mongoose.models.AutoContainmentDecision as unknown as Model<IAutoContainmentDecisionDocument>) ??
  model<IAutoContainmentDecisionDocument>('AutoContainmentDecision', AutoContainmentDecisionSchema);

type DecisionTierField =
  'tier' | 'policyVersion' | 'scope' | 'expiresAt' | 'releaseCondition' | 'releasedAt' | 'releasedBy' | 'releaseReason';

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

  /**
   * Turns a graduated decision on the revision into a pending Contain claim, since the unique
   * (detection, revision) pair leaves Contain no row of its own. Atomic; a graduated decision still
   * being applied (fresh `pending`) is left alone. Null when nothing moved. The caller lifts the
   * holds the graduated decision placed: they keep this decision's id.
   */
  async supersedeWithContain(
    id: string,
    claim: Pick<AutoContainmentDecisionItem, 'assessmentId' | 'mode' | 'userIds' | 'confidence' | 'reason'> & {
      staleBefore: Date;
      now: Date;
    }
  ): Promise<AutoContainmentDecisionItem | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    const { staleBefore, now, ...fields } = claim;
    const doc = await AutoContainmentDecisionModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        tier: { $in: INTERVENTION_TIERS.filter(tier => tier !== 'contain') },
        $or: [{ outcome: { $ne: 'pending' } }, { outcome: 'pending', decidedAt: { $lt: staleBefore } }],
      },
      {
        $set: {
          ...fields,
          tier: 'contain',
          scope: 'account',
          policyVersion: null,
          expiresAt: null,
          releaseCondition: null,
          releasedAt: null,
          releasedBy: null,
          releaseReason: null,
          outcome: 'pending',
          batchId: null,
          error: null,
          decidedAt: now,
        },
      },
      { new: true, runValidators: true }
    ).lean<LeanDecision>();
    return doc ? toItem(doc) : null;
  }

  /** Records how a claimed decision ended. */
  async finish(id: string, patch: Pick<AutoContainmentDecisionItem, 'outcome' | 'batchId' | 'error'>): Promise<void> {
    await AutoContainmentDecisionModel.updateOne({ _id: new Types.ObjectId(id) }, { $set: patch });
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
