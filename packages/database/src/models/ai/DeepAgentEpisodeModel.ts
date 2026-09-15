import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { EvidenceTier, EVIDENCE_TIERS, IDriveVector, driveVectorSchemaDef } from './deepAgentTypes';

const ModelName = 'DeepAgentEpisode';

/**
 * An Episode is the per-wake-cycle structured record - append-only and
 * unbounded; the agent's raw experience log. The groom step periodically
 * consolidates episodes into Charter semantic memory.
 *
 * Persistence model for `EpisodeSchema` in
 * `@bike4mind/agents/src/deepAgent/schemas/episode.ts`. Keep field shapes in
 * sync with the Zod schema; `wakeAt` is a `Date` here (ISO string in Zod).
 */

export interface IPolicyDecision {
  actionKind: string;
  rationale: string;
  expectedDriveDelta: Record<string, number>;
}

export interface IActionTaken {
  tool: string;
  input: unknown;
  succeeded: boolean;
  durationMs?: number;
}

export interface IObservation {
  kind: string;
  summary: string;
  artifactRef?: string;
}

export interface ICharterDiff {
  addedSemanticMemory: string[];
  removedSemanticMemoryIds: string[];
  subgoalStatusChanges: string[];
  summary: string;
}

export interface IDeepAgentEpisode extends IMongoDocument {
  episodeId: string;
  agentId: string;
  wakeAt: Date;
  drivesBefore: IDriveVector;
  policyDecision: IPolicyDecision;
  actionsTaken: IActionTaken[];
  observations: IObservation[];
  reflection: string;
  charterDiff: ICharterDiff;
  drivesAfter: IDriveVector;
  scopeLocks: string[];
  evidenceTier: EvidenceTier;
  tokensSpent: number;
  costUsd: number;
  reviewedByEpisodeId?: string;
}

interface IDeepAgentEpisodeModel extends Model<IDeepAgentEpisode> {}

const PolicyDecisionSchema = new Schema<IPolicyDecision>(
  {
    actionKind: { type: String, required: true },
    rationale: { type: String, required: true },
    expectedDriveDelta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const ActionTakenSchema = new Schema<IActionTaken>(
  {
    tool: { type: String, required: true },
    input: { type: Schema.Types.Mixed },
    succeeded: { type: Boolean, required: true },
    durationMs: { type: Number, min: 0 },
  },
  { _id: false }
);

const ObservationSchema = new Schema<IObservation>(
  {
    kind: { type: String, required: true },
    summary: { type: String, required: true },
    artifactRef: { type: String },
  },
  { _id: false }
);

const CharterDiffSchema = new Schema<ICharterDiff>(
  {
    addedSemanticMemory: { type: [String], default: [] },
    removedSemanticMemoryIds: { type: [String], default: [] },
    subgoalStatusChanges: { type: [String], default: [] },
    summary: { type: String, required: true },
  },
  { _id: false }
);

const DeepAgentEpisodeSchema = new Schema<IDeepAgentEpisode>(
  {
    // Agent-supplied stable id (ULID/UUID). Distinct from Mongo `_id`/`id`.
    episodeId: { type: String, required: true },
    agentId: { type: String, required: true },
    wakeAt: { type: Date, required: true },
    drivesBefore: { type: driveVectorSchemaDef, required: true, _id: false },
    policyDecision: { type: PolicyDecisionSchema, required: true },
    actionsTaken: { type: [ActionTakenSchema], default: [] },
    observations: { type: [ObservationSchema], default: [] },
    reflection: { type: String, required: true },
    charterDiff: { type: CharterDiffSchema, required: true },
    drivesAfter: { type: driveVectorSchemaDef, required: true, _id: false },
    scopeLocks: { type: [String], default: [] },
    evidenceTier: { type: String, enum: EVIDENCE_TIERS, required: true },
    tokensSpent: { type: Number, min: 0, default: 0 },
    costUsd: { type: Number, min: 0, default: 0 },
    reviewedByEpisodeId: { type: String },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// --- Indexes ---
// Load the tail of episodic memory for an agent (most-recent first).
DeepAgentEpisodeSchema.index({ agentId: 1, wakeAt: -1 });
// Resolve an episode by its agent-supplied id (e.g. handoff.lastEpisodeId).
DeepAgentEpisodeSchema.index({ agentId: 1, episodeId: 1 }, { unique: true });

// --- Repository ---

class DeepAgentEpisodeRepository extends BaseRepository<IDeepAgentEpisode> {
  constructor(episodeModel: mongoose.Model<IDeepAgentEpisode>) {
    super(episodeModel);
  }

  /** Append a new episode to the log. Episodes are immutable once written. */
  async append(episode: Omit<IDeepAgentEpisode, 'id' | 'createdAt' | 'updatedAt'>): Promise<IDeepAgentEpisode> {
    const result = await this.model.create(episode);
    return result.toObject();
  }

  /** Most-recent episodes for an agent, newest first. */
  async findRecentByAgentId(agentId: string, limit = 10): Promise<IDeepAgentEpisode[]> {
    const results = await this.model.find({ agentId }).sort({ wakeAt: -1 }).limit(limit);
    return results.map(d => d.toObject());
  }

  async findByEpisodeId(agentId: string, episodeId: string): Promise<IDeepAgentEpisode | null> {
    const result = await this.model.findOne({ agentId, episodeId });
    return result?.toObject() ?? null;
  }

  /**
   * Set the reviewer back-pointer on an episode. The single sanctioned
   * post-write mutation of the otherwise append-only log (the schema's
   * `reviewedByEpisodeId` exists exactly for this) - and it is WRITE-ONCE:
   * a second review must not clobber the original audit pointer. Throws if
   * the episode is missing or already reviewed.
   */
  async setReviewedBy(agentId: string, episodeId: string, reviewerEpisodeId: string): Promise<void> {
    const result = await this.model.updateOne(
      { agentId, episodeId, reviewedByEpisodeId: { $exists: false } },
      { $set: { reviewedByEpisodeId: reviewerEpisodeId } }
    );
    if (result.matchedCount === 0) {
      const existing = await this.model.findOne({ agentId, episodeId }).select({ reviewedByEpisodeId: 1 });
      throw new Error(
        existing
          ? `episode ${episodeId} already reviewed by ${existing.reviewedByEpisodeId}`
          : `episode ${episodeId} not found for agent ${agentId}`
      );
    }
  }
}

// --- Model & Export ---

const DeepAgentEpisodeModel: IDeepAgentEpisodeModel =
  (mongoose.models[ModelName] as IDeepAgentEpisodeModel) ||
  mongoose.model<IDeepAgentEpisode, IDeepAgentEpisodeModel>(ModelName, DeepAgentEpisodeSchema);

export const deepAgentEpisodeRepository = new DeepAgentEpisodeRepository(DeepAgentEpisodeModel);

export default DeepAgentEpisodeModel;
