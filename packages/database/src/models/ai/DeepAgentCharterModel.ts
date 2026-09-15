import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { EvidenceTier, EVIDENCE_TIERS, IDriveVector, driveVectorSchemaDef } from './deepAgentTypes';

const ModelName = 'DeepAgentCharter';

/**
 * The Charter is the slow-changing identity + goal + groomed-memory document a
 * deep agent reads on every wake. One per agent (keyed by `identity.agentId`).
 *
 * Persistence model for `CharterSchema` in
 * `@bike4mind/agents/src/deepAgent/schemas/charter.ts`. Domain timestamps that
 * the Zod layer carries as ISO strings (`updatedAt`) are owned here by Mongoose
 * `timestamps` as `Date`; the Zod<->Mongo conversion happens at the runtime seam.
 * Keep field shapes in sync with the Zod schema.
 */

export interface ICharterIdentity {
  agentId: string;
  ownerUserId: string;
  /** Mission linkage: the B4M AgentModel this charter belongs to (optional). */
  linkedAgentId?: string;
  name: string;
  role: string;
  instantiatedAt: Date;
  schemaVersion: 1;
}

export interface ICharterGoal {
  description: string;
  successCriteria: string[];
  deadlineKind: 'none' | 'soft' | 'hard';
  deadlineAt?: Date;
}

export type SubgoalStatus = 'planned' | 'active' | 'blocked' | 'completed' | 'abandoned';

export interface ISubgoal {
  id: string;
  description: string;
  status: SubgoalStatus;
  priority: number;
  targetTier: EvidenceTier;
  dependsOn: string[];
}

export interface ISemanticMemoryEntry {
  id: string;
  fact: string;
  evidenceTier: EvidenceTier;
  confidence: number;
  sourceEpisodeIds: string[];
  lastAffirmedAt: Date;
}

export interface IDeepAgentCharter extends IMongoDocument {
  identity: ICharterIdentity;
  goal: ICharterGoal;
  drives: IDriveVector;
  subgoals: ISubgoal[];
  semanticMemory: ISemanticMemoryEntry[];
  currentTier: EvidenceTier;
  openQuestions: string[];
  blockers: string[];
  /** The B4M session acting as the mission log (lazily created). */
  sessionId?: string;
  sizeBudgetBytes: number;
  version: number;
  groomedAt?: Date;
}

interface IDeepAgentCharterModel extends Model<IDeepAgentCharter> {}

const SUBGOAL_STATUSES: SubgoalStatus[] = ['planned', 'active', 'blocked', 'completed', 'abandoned'];

const IdentitySchema = new Schema<ICharterIdentity>(
  {
    agentId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    linkedAgentId: { type: String },
    name: { type: String, required: true },
    role: { type: String, required: true },
    instantiatedAt: { type: Date, required: true },
    schemaVersion: { type: Number, required: true, enum: [1], default: 1 },
  },
  { _id: false }
);

const GoalSchema = new Schema<ICharterGoal>(
  {
    description: { type: String, required: true },
    successCriteria: { type: [String], default: [] },
    deadlineKind: { type: String, enum: ['none', 'soft', 'hard'], default: 'none' },
    deadlineAt: { type: Date },
  },
  { _id: false }
);

const SubgoalSchema = new Schema<ISubgoal>(
  {
    id: { type: String, required: true },
    description: { type: String, required: true },
    status: { type: String, enum: SUBGOAL_STATUSES, default: 'planned' },
    priority: { type: Number, min: 0, max: 100, default: 50 },
    targetTier: { type: String, enum: EVIDENCE_TIERS, default: 'engineering-scaled' },
    dependsOn: { type: [String], default: [] },
  },
  { _id: false }
);

const SemanticMemoryEntrySchema = new Schema<ISemanticMemoryEntry>(
  {
    id: { type: String, required: true },
    fact: { type: String, required: true },
    evidenceTier: { type: String, enum: EVIDENCE_TIERS, required: true },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },
    sourceEpisodeIds: { type: [String], default: [] },
    lastAffirmedAt: { type: Date, required: true },
  },
  { _id: false }
);

const DeepAgentCharterSchema = new Schema<IDeepAgentCharter>(
  {
    identity: { type: IdentitySchema, required: true },
    goal: { type: GoalSchema, required: true },
    drives: { type: driveVectorSchemaDef, required: true, _id: false },
    subgoals: { type: [SubgoalSchema], default: [] },
    semanticMemory: { type: [SemanticMemoryEntrySchema], default: [] },
    currentTier: { type: String, enum: EVIDENCE_TIERS, default: 'engineering-proxy' },
    openQuestions: { type: [String], default: [] },
    blockers: { type: [String], default: [] },
    sessionId: { type: String },
    sizeBudgetBytes: { type: Number, default: 8 * 1024 },
    version: { type: Number, default: 0 },
    groomedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// --- Indexes ---
// One charter per agent - the load-bearing key across all storage.
DeepAgentCharterSchema.index({ 'identity.agentId': 1 }, { unique: true });
// Console roster: list an owner's agents, most recently updated first.
DeepAgentCharterSchema.index({ 'identity.ownerUserId': 1, updatedAt: -1 });
// Missions of a B4M agent, most recently active first. Partial so standalone
// deep agents (no linkedAgentId) stay out of the index - a plain index would
// hold them under a null key, inflating index size + write cost. Equality
// queries on linkedAgentId imply $exists:true, so listByLinkedAgentId still
// uses it. (sparse won't work here: updatedAt is always present, so a sparse
// compound index would still include every doc.)
DeepAgentCharterSchema.index(
  { 'identity.linkedAgentId': 1, updatedAt: -1 },
  { partialFilterExpression: { 'identity.linkedAgentId': { $exists: true } } }
);
// Badge counts: group an owner's LINKED charters by agent. Sparse so the
// index only holds the linked subset (standalone deep agents stay out of it),
// letting countByLinkedAgentForOwner skip the $exists collection scan.
DeepAgentCharterSchema.index({ 'identity.ownerUserId': 1, 'identity.linkedAgentId': 1 }, { sparse: true });

// --- Repository ---

class DeepAgentCharterRepository extends BaseRepository<IDeepAgentCharter> {
  constructor(charterModel: mongoose.Model<IDeepAgentCharter>) {
    super(charterModel);
  }

  async findByAgentId(agentId: string): Promise<IDeepAgentCharter | null> {
    const result = await this.model.findOne({ 'identity.agentId': agentId });
    return result?.toObject() ?? null;
  }

  /** An owner's agents, most recently updated first (console roster). */
  async listByOwnerUserId(ownerUserId: string, limit = 50): Promise<IDeepAgentCharter[]> {
    const docs = await this.model.find({ 'identity.ownerUserId': ownerUserId }).sort({ updatedAt: -1 }).limit(limit);
    return docs.map(d => d.toObject());
  }

  /**
   * Attach the mission-log session. A sanctioned unversioned write (like the
   * episode reviewer back-pointer): operational metadata, not wake state, and
   * write-once so a racing bridge can't re-point the log.
   */
  async setSessionId(agentId: string, sessionId: string): Promise<void> {
    await this.model.updateOne({ 'identity.agentId': agentId, sessionId: { $exists: false } }, { $set: { sessionId } });
  }

  /**
   * Re-point the mission log when the stored session is gone (deleted notebook).
   * CAS off the dead id so it's race-safe: only the wake that still sees the dead
   * pointer wins; a concurrent wake that already re-pointed leaves this a no-op.
   * Distinct from the write-once setSessionId, which must never re-point a LIVE
   * session out from under a racing bridge.
   */
  async repointSessionId(agentId: string, fromSessionId: string, toSessionId: string): Promise<void> {
    await this.model.updateOne(
      { 'identity.agentId': agentId, sessionId: fromSessionId },
      { $set: { sessionId: toSessionId } }
    );
  }

  /** Mission counts per linked B4M agent for one owner (console badges). */
  async countByLinkedAgentForOwner(ownerUserId: string): Promise<Record<string, number>> {
    const rows = await this.model.aggregate<{ _id: string; count: number }>([
      { $match: { 'identity.ownerUserId': ownerUserId, 'identity.linkedAgentId': { $exists: true } } },
      { $group: { _id: '$identity.linkedAgentId', count: { $sum: 1 } } },
    ]);
    return Object.fromEntries(rows.map(r => [r._id, r.count]));
  }

  /** Missions linked to a B4M agent, most recently active first. */
  async listByLinkedAgentId(linkedAgentId: string, limit = 50): Promise<IDeepAgentCharter[]> {
    const docs = await this.model
      .find({ 'identity.linkedAgentId': linkedAgentId })
      .sort({ updatedAt: -1 })
      .limit(limit);
    return docs.map(d => d.toObject());
  }

  /**
   * Create-or-replace the charter for an agent. The caller owns the monotonic
   * `version` counter (it should increment it before each groom write); this
   * method persists whatever it is handed. Called by the groom step after
   * compaction.
   */
  async upsertForAgent(charter: Omit<IDeepAgentCharter, 'id' | 'createdAt' | 'updatedAt'>): Promise<IDeepAgentCharter> {
    const result = await this.model.findOneAndUpdate(
      { 'identity.agentId': charter.identity.agentId },
      { $set: charter },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return result.toObject();
  }

  /**
   * Optimistic-concurrency save. The wake cycle bumps `version` exactly once
   * per wake, so:
   *   - version 0  -> fresh enrollment: insert (the unique agentId index turns
   *     a duplicate enrollment into a conflict)
   *   - version N>0 -> the write only matches if the stored doc is still at
   *     N-1; a concurrent wake that already advanced it makes this a no-match
   *     -> stale-write conflict, and the caller (SQS) retries against fresh state.
   *
   * This is the backstop for SQS at-least-once redelivery and any scheduler
   * race the wake lease doesn't catch.
   */
  async saveVersioned(charter: Omit<IDeepAgentCharter, 'id' | 'createdAt' | 'updatedAt'>): Promise<IDeepAgentCharter> {
    const agentId = charter.identity.agentId;
    if (charter.version === 0) {
      try {
        const created = await this.model.create(charter);
        return created.toObject();
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw new Error(`deep agent charter conflict: agent ${agentId} already enrolled`);
        }
        throw err;
      }
    }
    const result = await this.model.findOneAndUpdate(
      { 'identity.agentId': agentId, version: charter.version - 1 },
      { $set: charter },
      { new: true }
    );
    if (!result) {
      throw new Error(
        `deep agent charter stale write: agent ${agentId} expected v${charter.version - 1} (concurrent wake?)`
      );
    }
    return result.toObject();
  }
}

// --- Model & Export ---

const DeepAgentCharterModel: IDeepAgentCharterModel =
  (mongoose.models[ModelName] as IDeepAgentCharterModel) ||
  mongoose.model<IDeepAgentCharter, IDeepAgentCharterModel>(ModelName, DeepAgentCharterSchema);

export const deepAgentCharterRepository = new DeepAgentCharterRepository(DeepAgentCharterModel);

export default DeepAgentCharterModel;
