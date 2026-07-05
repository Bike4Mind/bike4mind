import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DeepAgentHandoff';

/**
 * The Handoff is the fast-changing, per-wake document that captures where the
 * agent left off and what it intends to do next. One per agent. Rewritten on
 * every wake - the cheap counterpart to the slow-changing Charter.
 *
 * Persistence model for `HandoffSchema` in
 * `@bike4mind/agents/src/deepAgent/schemas/handoff.ts`. The Zod layer carries
 * `lastWakeAt`/`updatedAt` as ISO strings; here `updatedAt` is Mongoose-owned
 * (Date) and `lastWakeAt` is a `Date`. Keep field shapes in sync.
 */
export interface IDeepAgentHandoff extends IMongoDocument {
  agentId: string;
  wakeCount: number;
  lastWakeAt: Date;
  lastActionSummary: string;
  nextIntendedAction: string;
  nextWakeIntervalMs?: number;
  openBlockers: string[];
  lastEpisodeId?: string;
  /**
   * Derived, Mongo-only scheduling field: `lastWakeAt + nextWakeIntervalMs`.
   * Computed on every write (not part of the domain DTO) so the wake scheduler
   * can find due agents with a single indexed query. Absent when the agent has
   * no wake interval (dormant until manually triggered).
   */
  nextWakeAt?: Date;
}

interface IDeepAgentHandoffModel extends Model<IDeepAgentHandoff> {}

const DeepAgentHandoffSchema = new Schema<IDeepAgentHandoff>(
  {
    agentId: { type: String, required: true },
    wakeCount: { type: Number, required: true, min: 0 },
    lastWakeAt: { type: Date, required: true },
    lastActionSummary: { type: String, default: '' },
    nextIntendedAction: { type: String, default: '' },
    nextWakeIntervalMs: { type: Number, min: 1 },
    openBlockers: { type: [String], default: [] },
    lastEpisodeId: { type: String },
    nextWakeAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// --- Indexes ---
// One handoff per agent - read first on every wake.
DeepAgentHandoffSchema.index({ agentId: 1 }, { unique: true });
// Wake scheduler: find agents whose next wake is due (nextWakeAt <= now).
DeepAgentHandoffSchema.index({ nextWakeAt: 1 });

// --- Repository ---

class DeepAgentHandoffRepository extends BaseRepository<IDeepAgentHandoff> {
  constructor(handoffModel: mongoose.Model<IDeepAgentHandoff>) {
    super(handoffModel);
  }

  async findByAgentId(agentId: string): Promise<IDeepAgentHandoff | null> {
    const result = await this.model.findOne({ agentId });
    return result?.toObject() ?? null;
  }

  /** Batch lookup for the console roster (one query, not N). */
  async findByAgentIds(agentIds: string[]): Promise<IDeepAgentHandoff[]> {
    if (agentIds.length === 0) return [];
    const docs = await this.model.find({ agentId: { $in: agentIds } });
    return docs.map(d => d.toObject());
  }

  /**
   * Create-or-replace the handoff for an agent. Called at the end of every wake.
   * Derives `nextWakeAt` from `lastWakeAt + nextWakeIntervalMs` so the scheduler
   * can find due agents with one indexed query; cleared when no interval is set.
   */
  async upsertForAgent(
    handoff: Omit<IDeepAgentHandoff, 'id' | 'createdAt' | 'updatedAt' | 'nextWakeAt'>
  ): Promise<IDeepAgentHandoff> {
    const nextWakeAt =
      handoff.nextWakeIntervalMs != null
        ? new Date(handoff.lastWakeAt.getTime() + handoff.nextWakeIntervalMs)
        : undefined;
    const result = await this.model.findOneAndUpdate(
      { agentId: handoff.agentId },
      nextWakeAt ? { $set: { ...handoff, nextWakeAt } } : { $set: handoff, $unset: { nextWakeAt: '' } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return result.toObject();
  }

  /**
   * Agent ids whose next wake is due (`nextWakeAt <= now`), oldest first.
   * Read-only introspection - the scheduler should use `claimDueAgentIds`,
   * which atomically leases each agent so concurrent cron ticks can't
   * double-enqueue an in-flight wake.
   */
  async findDueAgentIds(now: Date, limit = 100): Promise<string[]> {
    const docs = await this.model
      .find({ nextWakeAt: { $lte: now } })
      .sort({ nextWakeAt: 1 })
      .limit(limit)
      .select({ agentId: 1 });
    return docs.map(d => d.agentId);
  }

  /**
   * Atomically CLAIM due agents for waking. Each claim is a single
   * findOneAndUpdate that pushes `nextWakeAt` forward by `leaseMs`, so a
   * concurrent scheduler tick (or a second scheduler instance) cannot claim
   * the same agent - the filter no longer matches once leased.
   *
   * If the wake completes, the end-of-wake handoff write sets the real
   * `nextWakeAt`. If the wake dies mid-flight, the lease expires and the
   * agent is reclaimed after `leaseMs` - at-least-once with bounded delay.
   */
  async claimDueAgentIds(now: Date, leaseMs: number, limit = 100): Promise<string[]> {
    const claimed: string[] = [];
    const leaseUntil = new Date(now.getTime() + leaseMs);
    for (let i = 0; i < limit; i++) {
      const doc = await this.model.findOneAndUpdate(
        { nextWakeAt: { $lte: now } },
        { $set: { nextWakeAt: leaseUntil } },
        { sort: { nextWakeAt: 1 }, new: false }
      );
      if (!doc) break;
      claimed.push(doc.agentId);
    }
    return claimed;
  }

  /**
   * Hand back a claim whose enqueue failed: reset `nextWakeAt` to `at` so the
   * next scheduler tick retries immediately instead of waiting out the lease.
   */
  async releaseWakeClaim(agentId: string, at: Date): Promise<void> {
    await this.model.updateOne({ agentId }, { $set: { nextWakeAt: at } });
  }
}

// --- Model & Export ---

const DeepAgentHandoffModel: IDeepAgentHandoffModel =
  (mongoose.models[ModelName] as IDeepAgentHandoffModel) ||
  mongoose.model<IDeepAgentHandoff, IDeepAgentHandoffModel>(ModelName, DeepAgentHandoffSchema);

export const deepAgentHandoffRepository = new DeepAgentHandoffRepository(DeepAgentHandoffModel);

export default DeepAgentHandoffModel;
