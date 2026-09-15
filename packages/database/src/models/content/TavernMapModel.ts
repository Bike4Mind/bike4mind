import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'TavernMap';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Custom map dimension bounds (tiles). Max is bounded by TavernWorld MAX_COORD=95
 * (coords 0..95 -> up to 96 tiles per axis). Maps are rectangular: width and
 * height are chosen independently.
 */
export const MIN_MAP_DIM = 4;
export const MAX_MAP_DIM = 96;

/** Default dimensions for a new custom map (landscape, fits a wide screen). */
export const DEFAULT_MAP_WIDTH = 30;
export const DEFAULT_MAP_HEIGHT = 20;

/**
 * Default ground-fill tile for a freshly created custom map. Mirrors
 * `FLOOR_TILES[0]` in apps/client/app/utils/tavern/townGenerator.ts. Hardcoded
 * here (not imported) to avoid the DB package depending on client code.
 */
export const DEFAULT_FLOOR_TILE_GID = 4;

/** Dimensions of the legacy procedurally-generated tavern town. */
const TAVERN_SIZE = 96;

/** Max custom maps a single user may own (excludes the tavern entry). */
export const MAX_CUSTOM_MAPS_PER_USER = 50;

const MAX_NAME_LENGTH = 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TavernMapKind = 'tavern' | 'custom';

export interface ITavernMapDoc {
  _id: string;
  /** Stable map identifier. Doubles as the TavernWorld `worldId`. For the
   * legacy tavern, mapId === ownerId (the userId). */
  mapId: string;
  ownerId: string;
  name: string;
  widthTiles: number;
  heightTiles: number;
  kind: TavernMapKind;
  /** GID the ground layer was pre-filled with on creation (custom maps). */
  floorTileGid: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ITavernMapModel extends Model<ITavernMapDoc> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TavernMapSchema = new Schema<ITavernMapDoc>(
  {
    mapId: { type: String, required: true, unique: true },
    ownerId: { type: String, required: true },
    name: { type: String, required: true },
    widthTiles: { type: Number, required: true },
    heightTiles: { type: Number, required: true },
    kind: { type: String, enum: ['tavern', 'custom'], required: true, default: 'custom' },
    floorTileGid: { type: Number, required: true, default: DEFAULT_FLOOR_TILE_GID },
  },
  { timestamps: true }
);

// Performance index - covers both the `listMaps` find+sort ({ ownerId } sorted
// by createdAt) and the `createMap` quota check (countDocuments { ownerId, kind }).
TavernMapSchema.index({ ownerId: 1, kind: 1, createdAt: 1 });

export const TavernMap: ITavernMapModel =
  (mongoose.models[ModelName] as ITavernMapModel) || model<ITavernMapDoc, ITavernMapModel>(ModelName, TavernMapSchema);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidDim(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_MAP_DIM && n <= MAX_MAP_DIM;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const tavernMapRepository = {
  /**
   * List all maps owned by a user. Lazily seeds the legacy tavern entry
   * (mapId === ownerId) on first access so the tavern always appears in the
   * map list. Returns maps sorted by creation order (tavern first).
   */
  async listMaps(ownerId: string): Promise<ITavernMapDoc[]> {
    // Upsert the tavern entry without clobbering an existing one.
    await TavernMap.updateOne(
      { mapId: ownerId },
      {
        $setOnInsert: {
          mapId: ownerId,
          ownerId,
          name: 'The Tavern',
          widthTiles: TAVERN_SIZE,
          heightTiles: TAVERN_SIZE,
          kind: 'tavern',
          floorTileGid: DEFAULT_FLOOR_TILE_GID,
        },
      },
      { upsert: true }
    );

    const maps = (await TavernMap.find({ ownerId }).sort({ createdAt: 1 }).lean()) as unknown as ITavernMapDoc[];

    // Tavern always first, then custom maps by creation order.
    return maps.sort((a, b) => {
      if (a.kind === 'tavern' && b.kind !== 'tavern') return -1;
      if (b.kind === 'tavern' && a.kind !== 'tavern') return 1;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  },

  /**
   * Create a new custom map with rectangular dimensions. Validates name +
   * width/height (each in [MIN_MAP_DIM, MAX_MAP_DIM]) and enforces a per-user
   * quota. Throws on invalid input or quota exceeded.
   */
  async createMap(
    ownerId: string,
    mapId: string,
    name: string,
    widthTiles: number,
    heightTiles: number,
    floorTileGid: number = DEFAULT_FLOOR_TILE_GID
  ): Promise<ITavernMapDoc> {
    const trimmed = (name ?? '').trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
      throw new Error(`Invalid map name (1-${MAX_NAME_LENGTH} chars required)`);
    }
    if (!isValidDim(widthTiles) || !isValidDim(heightTiles)) {
      throw new Error(`Invalid map dimensions (each must be ${MIN_MAP_DIM}-${MAX_MAP_DIM} tiles)`);
    }

    const customCount = await TavernMap.countDocuments({ ownerId, kind: 'custom' });
    if (customCount >= MAX_CUSTOM_MAPS_PER_USER) {
      throw new Error(`Map quota exceeded (max ${MAX_CUSTOM_MAPS_PER_USER})`);
    }

    const doc = await TavernMap.create({
      mapId,
      ownerId,
      name: trimmed,
      widthTiles,
      heightTiles,
      kind: 'custom',
      floorTileGid,
    });
    return doc.toObject() as unknown as ITavernMapDoc;
  },

  async getMap(mapId: string): Promise<ITavernMapDoc | null> {
    return TavernMap.findOne({ mapId }).lean() as unknown as ITavernMapDoc | null;
  },

  /**
   * Delete a custom map. Refuses to delete the tavern entry. Returns true if
   * a custom map was deleted.
   */
  async deleteMap(mapId: string, ownerId: string): Promise<boolean> {
    const result = await TavernMap.deleteOne({ mapId, ownerId, kind: 'custom' });
    return result.deletedCount > 0;
  },

  /**
   * Authorize a user to read/write the world behind `mapId`.
   * - The legacy tavern (mapId === userId) always passes without requiring a
   *   metadata doc, preserving pre-Map-Editor behavior.
   * - Otherwise the TavernMap must exist and be owned by the user.
   */
  async assertOwnership(mapId: string, userId: string): Promise<{ ok: boolean }> {
    if (mapId === userId) return { ok: true };
    const doc = (await TavernMap.findOne({ mapId }).select('ownerId').lean()) as { ownerId: string } | null;
    return { ok: !!doc && doc.ownerId === userId };
  },
};
