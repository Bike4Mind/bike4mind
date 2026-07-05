import {
  CcAgentCapability,
  CcAgentSource,
  CcAgentStatus,
  type ICcAgentCapability,
  type ICcAgentSource,
  type ICcAgentStatus,
} from '@bike4mind/common';
import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'ActiveCodeAgent';

/**
 * Ephemeral record of a live Claude Code session embodied in the Tavern.
 *
 * Lifetime bracketing:
 * - Created / upserted on a `cc_agent_register` WS message.
 * - `lastEventAt` bumped on every `cc_agent_event` so the TTL doesn't sweep
 *   a healthy session.
 * - Deleted explicitly on `cc_agent_disconnect` and on WS `$disconnect`.
 * - TTL index on `lastEventAt` is the safety net for crashed bridges.
 */
export interface IActiveCodeAgentDoc {
  _id: string;
  userId: string;
  /** `_id` of the originating `CcBridgeDevice`. */
  deviceId: string;
  /** UUID the bridge generates per CC session - globally unique. */
  instanceId: string;
  /** WS connectionId the bridge is currently on. Rewritten on reconnect. */
  connectionId: string;
  workspaceName: string;
  workspacePath: string;
  claudeVersion?: string;
  /** Engine driving this session. Defaults to `'claude'` for backward compat
   *  (older bridges predate the field). Chip color in the tavern keys off this. */
  source: ICcAgentSource;
  /** Interactive affordances this session supports. Empty for observer+. */
  capabilities: ICcAgentCapability[];
  status: ICcAgentStatus;
  /** Short last-message snippet used for the hover preview. */
  lastSummary?: string;
  /** Sprite sheet id selected when the agent spawned. */
  spriteId: string;
  /** Last known tile position (fractional during a walk tween). */
  position: { x: number; y: number };
  /** ISO timestamp the CC session started on the user's machine. */
  startedAt: Date;
  /** Bumped on every event; drives the TTL sweep. */
  lastEventAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IActiveCodeAgentModel extends Model<IActiveCodeAgentDoc> {}

const ActiveCodeAgentSchema = new Schema<IActiveCodeAgentDoc>(
  {
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    instanceId: { type: String, required: true, unique: true },
    connectionId: { type: String, required: true },
    workspaceName: { type: String, required: true },
    workspacePath: { type: String, required: true },
    claudeVersion: { type: String },
    source: {
      type: String,
      enum: CcAgentSource.options,
      required: true,
      default: 'claude',
    },
    capabilities: {
      type: [{ type: String, enum: CcAgentCapability.options }],
      required: true,
      default: [],
    },
    status: {
      type: String,
      enum: CcAgentStatus.options,
      required: true,
      default: 'running',
    },
    lastSummary: { type: String },
    spriteId: { type: String, required: true },
    position: {
      x: { type: Number, required: true },
      y: { type: Number, required: true },
    },
    startedAt: { type: Date, required: true },
    lastEventAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true }
);

// Safety-net TTL: sweep records whose bridges vanished without $disconnect.
// Normal sessions refresh `lastEventAt` constantly via the bridge's liveness
// heartbeat (every 3 min); records that go stale beyond our client-side
// filter (10 min) are not shown anyway, so a 15-min TTL keeps Mongo tidy
// without risking a live session's record being swept mid-use.
ActiveCodeAgentSchema.index({ lastEventAt: 1 }, { expireAfterSeconds: 15 * 60 });
ActiveCodeAgentSchema.index({ userId: 1, lastEventAt: -1 });
ActiveCodeAgentSchema.index({ connectionId: 1 });
ActiveCodeAgentSchema.index({ userId: 1, deviceId: 1 });

export const ActiveCodeAgent: IActiveCodeAgentModel =
  (mongoose.models[ModelName] as IActiveCodeAgentModel) ||
  model<IActiveCodeAgentDoc, IActiveCodeAgentModel>(ModelName, ActiveCodeAgentSchema);

export const activeCodeAgentRepository = {
  /** Upsert a session record on register. Idempotent: bridge reconnects call this again. */
  async upsertOnRegister(
    doc: Pick<
      IActiveCodeAgentDoc,
      | 'userId'
      | 'deviceId'
      | 'instanceId'
      | 'connectionId'
      | 'workspaceName'
      | 'workspacePath'
      | 'spriteId'
      | 'position'
      | 'startedAt'
    > & {
      claudeVersion?: string;
      source?: ICcAgentSource;
      capabilities?: ICcAgentCapability[];
    }
  ): Promise<IActiveCodeAgentDoc> {
    const now = new Date();
    const result = await ActiveCodeAgent.findOneAndUpdate(
      { instanceId: doc.instanceId },
      {
        $set: {
          userId: doc.userId,
          deviceId: doc.deviceId,
          connectionId: doc.connectionId,
          workspaceName: doc.workspaceName,
          workspacePath: doc.workspacePath,
          claudeVersion: doc.claudeVersion,
          source: doc.source ?? 'claude',
          capabilities: doc.capabilities ?? [],
          spriteId: doc.spriteId,
          position: doc.position,
          startedAt: doc.startedAt,
          lastEventAt: now,
        },
        $setOnInsert: { status: 'running' as ICcAgentStatus },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    if (!result) {
      throw new Error(`Failed to upsert ActiveCodeAgent for instanceId=${doc.instanceId}`);
    }
    return result;
  },

  async findByInstanceId(instanceId: string): Promise<IActiveCodeAgentDoc | null> {
    return ActiveCodeAgent.findOne({ instanceId }).lean();
  },

  /**
   * User-scoped lookup. Prefer this over `findByInstanceId` followed by a
   * `userId` check on the route: the combined index covers both, and the
   * single query eliminates a timing side-channel between "unknown
   * instanceId" and "exists but not yours".
   */
  async findByInstanceIdForUser(instanceId: string, userId: string): Promise<IActiveCodeAgentDoc | null> {
    return ActiveCodeAgent.findOne({ instanceId, userId }).lean();
  },

  /**
   * List live sessions for a user. Stale records (no heartbeat within
   * `sinceMs`) are filtered in the query so callers don't need to
   * post-process. Defaults to the bridge's 10-min liveness window.
   *
   * `limit` caps the return size - a power user with hundreds of CI-runner
   * bridges would otherwise return an unbounded replay that the client
   * must then iterate on every tab-load.
   */
  async listForUser(userId: string, sinceMs = 10 * 60_000, limit = 200): Promise<IActiveCodeAgentDoc[]> {
    const cutoff = new Date(Date.now() - sinceMs);
    return ActiveCodeAgent.find({ userId, lastEventAt: { $gte: cutoff } })
      .sort({ lastEventAt: -1 })
      .limit(limit)
      .lean();
  },

  async updateStatus(
    instanceId: string,
    status: ICcAgentStatus,
    lastSummary?: string
  ): Promise<IActiveCodeAgentDoc | null> {
    const set: Record<string, unknown> = { status, lastEventAt: new Date() };
    if (lastSummary !== undefined) set.lastSummary = lastSummary;
    return ActiveCodeAgent.findOneAndUpdate({ instanceId }, { $set: set }, { new: true }).lean();
  },

  async updatePosition(instanceId: string, position: { x: number; y: number }): Promise<void> {
    await ActiveCodeAgent.updateOne({ instanceId }, { $set: { position, lastEventAt: new Date() } });
  },

  async touch(instanceId: string, summary?: string): Promise<void> {
    const set: Record<string, unknown> = { lastEventAt: new Date() };
    if (summary !== undefined) set.lastSummary = summary;
    await ActiveCodeAgent.updateOne({ instanceId }, { $set: set });
  },

  async removeByInstanceId(instanceId: string): Promise<boolean> {
    const res = await ActiveCodeAgent.deleteOne({ instanceId });
    return res.deletedCount > 0;
  },

  /** Sweep all records for a torn-down WS connection. Called from $disconnect. */
  async removeByConnectionId(connectionId: string): Promise<string[]> {
    const doomed = await ActiveCodeAgent.find({ connectionId }, { instanceId: 1 }).lean();
    if (doomed.length === 0) return [];
    await ActiveCodeAgent.deleteMany({ connectionId });
    return doomed.map(d => d.instanceId);
  },
};
