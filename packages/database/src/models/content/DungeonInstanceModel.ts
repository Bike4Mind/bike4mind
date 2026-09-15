import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'DungeonInstance';

// Types

export interface IDungeonInstanceDoc {
  _id: string;
  /** Stable dungeon identifier. Format: 'd' + timestamp + '_' + 4 random chars. */
  dungeonId: string;
  /** The map this dungeon belongs to. For the legacy tavern, worldId === ownerId. */
  worldId: string;
  ownerId: string;
  numSublevels: number;
  /** Seed read from TavernWorldModel surface doc at spawn time. */
  worldSeed: number;
  portalCol: number;
  portalRow: number;

  // Lifecycle
  status: 'active' | 'expiring' | 'expired';
  expiresAt: Date;
  expiredAt?: Date;

  // PotionQuest content - populated at spawn, optional (best-effort)
  name?: string;
  theme?: string;
  /** Max 10 entries, max 500 chars each. Reserved for future scan_nearby_tiles use. */
  roomDescriptions?: string[];

  /** Always 'manual' for M4.5. Reserved for timer/quest/agent auto-spawn. */
  spawnTrigger: 'manual' | 'timer' | 'quest' | 'agent';

  createdAt: Date;
  updatedAt: Date;
}

interface IDungeonInstanceModel extends Model<IDungeonInstanceDoc> {}

// Schema

const DungeonInstanceSchema = new Schema<IDungeonInstanceDoc>(
  {
    dungeonId: { type: String, required: true, unique: true },
    worldId: { type: String, required: true },
    ownerId: { type: String, required: true },
    numSublevels: { type: Number, required: true, default: 3 },
    worldSeed: { type: Number, required: true },
    portalCol: { type: Number, required: true },
    portalRow: { type: Number, required: true },

    status: {
      type: String,
      enum: ['active', 'expiring', 'expired'],
      required: true,
      default: 'active',
    },
    expiresAt: { type: Date, required: true },
    expiredAt: { type: Date },

    name: { type: String },
    theme: { type: String },
    roomDescriptions: [{ type: String }],

    spawnTrigger: {
      type: String,
      enum: ['manual', 'timer', 'quest', 'agent'],
      required: true,
      default: 'manual',
    },
  },
  { timestamps: true }
);

// Performance indexes
// Covers getActiveDungeons({ worldId, status }).
DungeonInstanceSchema.index({ worldId: 1, status: 1 });
// Covers getExpiredDungeons({ status: { $in }, expiresAt }) + sort. NOT a TTL
// index - application-level expiration handles cleanup.
DungeonInstanceSchema.index({ status: 1, expiresAt: 1 });
// Covers findMostRecent({ worldId }) sorted by createdAt desc (spawn rate limit).
DungeonInstanceSchema.index({ worldId: 1, createdAt: -1 });
// Single-dungeon-per-world constraint at the DB level (rejects duplicate active spawns)
DungeonInstanceSchema.index({ worldId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const DungeonInstance: IDungeonInstanceModel =
  (mongoose.models[ModelName] as IDungeonInstanceModel) ||
  model<IDungeonInstanceDoc, IDungeonInstanceModel>(ModelName, DungeonInstanceSchema);

// Repository

export type DungeonInstanceCreateParams = Pick<
  IDungeonInstanceDoc,
  'dungeonId' | 'worldId' | 'ownerId' | 'numSublevels' | 'worldSeed' | 'portalCol' | 'portalRow' | 'expiresAt'
> &
  Partial<Pick<IDungeonInstanceDoc, 'name' | 'theme' | 'roomDescriptions' | 'spawnTrigger'>>;

export const dungeonInstanceRepository = {
  async createInstance(params: DungeonInstanceCreateParams): Promise<IDungeonInstanceDoc> {
    const doc = await DungeonInstance.create({ ...params, status: 'active' });
    return doc.toObject() as IDungeonInstanceDoc;
  },

  async getActiveDungeons(worldId: string): Promise<IDungeonInstanceDoc[]> {
    return DungeonInstance.find({ worldId, status: 'active' }).lean() as unknown as IDungeonInstanceDoc[];
  },

  /**
   * Find dungeons that need expiration cleanup.
   * Includes 'expiring' status to resume interrupted cleanup flows.
   * Sorted oldest-first (fair FIFO drain); limited to 50 per cron tick.
   */
  async getExpiredDungeons(): Promise<IDungeonInstanceDoc[]> {
    return DungeonInstance.find({
      status: { $in: ['active', 'expiring'] },
      expiresAt: { $lte: new Date() },
    })
      .sort({ expiresAt: 1 })
      .limit(50)
      .lean() as unknown as IDungeonInstanceDoc[];
  },

  async findByDungeonId(dungeonId: string): Promise<IDungeonInstanceDoc | null> {
    return DungeonInstance.findOne({ dungeonId }).lean() as unknown as IDungeonInstanceDoc | null;
  },

  /** Idempotent: skips the update if already expiring or expired. */
  async markExpiring(dungeonId: string): Promise<IDungeonInstanceDoc | null> {
    return DungeonInstance.findOneAndUpdate(
      { dungeonId, status: 'active' },
      { $set: { status: 'expiring' } },
      { new: true }
    ).lean() as unknown as IDungeonInstanceDoc | null;
  },

  /** Idempotent: only transitions from non-expired states. */
  async markExpired(dungeonId: string): Promise<IDungeonInstanceDoc | null> {
    return DungeonInstance.findOneAndUpdate(
      { dungeonId, status: { $ne: 'expired' } },
      { $set: { status: 'expired', expiredAt: new Date() } },
      { new: true }
    ).lean() as unknown as IDungeonInstanceDoc | null;
  },

  /** Most recently created dungeon for a world (any status). Used for spawn rate limiting. */
  async findMostRecent(worldId: string): Promise<IDungeonInstanceDoc | null> {
    return DungeonInstance.findOne({ worldId }).sort({ createdAt: -1 }).lean() as unknown as IDungeonInstanceDoc | null;
  },

  async updateContent(
    dungeonId: string,
    content: { name?: string; theme?: string; roomDescriptions?: string[] }
  ): Promise<IDungeonInstanceDoc | null> {
    return DungeonInstance.findOneAndUpdate(
      { dungeonId },
      { $set: content },
      { new: true }
    ).lean() as unknown as IDungeonInstanceDoc | null;
  },
};
