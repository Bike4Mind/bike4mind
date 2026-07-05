import mongoose, { Model, Schema, model } from 'mongoose';
import { randomUUID } from 'crypto';

const ModelName = 'TavernWorld';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ITavernWorldEditHistoryEntry {
  batchId: string;
  timestamp: Date;
  source: 'user' | 'agent' | 'system';
  sourceId?: string;
  forward: Array<{ key: string; gid: number }>;
  reverse: Array<{ key: string; gid: number | null }>; // null = remove override
}

export interface ITavernWorldDoc {
  _id: string;
  worldId: string;
  ownerId: string;
  floorId: string;
  seed: number;
  generatorVersion: number;
  version: number;
  edits: Record<string, number>; // "layer:col,row" → gid (0 = cleared) — Record after .lean()
  editHistory: ITavernWorldEditHistoryEntry[];
  undoPointer: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ITavernWorldModel extends Model<ITavernWorldDoc> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const EditHistoryEntrySchema = new Schema(
  {
    batchId: { type: String, required: true },
    timestamp: { type: Date, required: true },
    source: { type: String, enum: ['user', 'agent', 'system'], required: true },
    sourceId: { type: String },
    forward: [
      {
        _id: false,
        key: { type: String, required: true },
        gid: { type: Number, required: true },
      },
    ],
    reverse: [
      {
        _id: false,
        key: { type: String, required: true },
        gid: { type: Number, default: null },
      },
    ],
  },
  { _id: false }
);

const TavernWorldSchema = new Schema<ITavernWorldDoc>(
  {
    worldId: { type: String, required: true },
    ownerId: { type: String, required: true },
    floorId: { type: String, required: true, default: 'surface' },
    seed: { type: Number, required: true },
    generatorVersion: { type: Number, required: true, default: 1 },
    version: { type: Number, required: true, default: 0 },
    edits: { type: Map, of: Number, default: () => new Map() },
    editHistory: { type: [EditHistoryEntrySchema], default: [] },
    undoPointer: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

// Performance indexes
TavernWorldSchema.index({ worldId: 1, floorId: 1 }, { unique: true });
TavernWorldSchema.index({ ownerId: 1 });

export const TavernWorld: ITavernWorldModel =
  (mongoose.models[ModelName] as ITavernWorldModel) ||
  model<ITavernWorldDoc, ITavernWorldModel>(ModelName, TavernWorldSchema);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_ENTRIES = 500;
const MAX_BATCH_SIZE = 2000;

const VALID_LAYERS = new Set(['ground', 'walls', 'structures', 'furniture', 'decoration']);
const MAX_COORD = 95;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateEditKey(key: string): boolean {
  const parts = key.split(':');
  if (parts.length !== 2) return false;
  const [layer, coords] = parts;
  if (!VALID_LAYERS.has(layer)) return false;
  const coordParts = coords.split(',');
  if (coordParts.length !== 2) return false;
  const col = parseInt(coordParts[0], 10);
  const row = parseInt(coordParts[1], 10);
  return Number.isInteger(col) && Number.isInteger(row) && col >= 0 && col <= MAX_COORD && row >= 0 && row <= MAX_COORD;
}

function validateGid(gid: number): boolean {
  return Number.isInteger(gid) && gid >= 0;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const tavernWorldRepository = {
  /**
   * Get or create a world document. New worlds get a random seed.
   */
  async getOrCreateWorld(worldId: string, ownerId: string, floorId = 'surface'): Promise<ITavernWorldDoc> {
    const randomSeed = Math.floor(Math.random() * 999999) + 1;
    const doc = (await TavernWorld.findOneAndUpdate(
      { worldId, floorId },
      {
        $setOnInsert: {
          worldId,
          ownerId,
          floorId,
          seed: randomSeed,
          generatorVersion: 1,
          version: 0,
          edits: new Map(),
          editHistory: [],
          undoPointer: 0,
        },
      },
      { upsert: true, new: true }
    ).lean()) as unknown as ITavernWorldDoc;
    return doc;
  },

  /**
   * Apply a batch of edits with optimistic concurrency.
   * Returns updated doc or null on version conflict (409).
   */
  async applyEdits(
    worldId: string,
    floorId: string,
    expectedVersion: number,
    batch: Array<{ key: string; gid: number }>,
    source: 'user' | 'agent' | 'system',
    sourceId?: string
  ): Promise<ITavernWorldDoc | null> {
    // Validate batch size
    if (batch.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size ${batch.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    // Validate all edit keys and gids
    for (const edit of batch) {
      if (!validateEditKey(edit.key)) {
        throw new Error(`Invalid edit key: ${edit.key}`);
      }
      if (!validateGid(edit.gid)) {
        throw new Error(`Invalid gid: ${edit.gid}`);
      }
    }

    const batchId = randomUUID();
    const now = new Date();

    // Build the edits map update
    const editsUpdate: Record<string, number> = {};
    for (const edit of batch) {
      editsUpdate[`edits.${edit.key}`] = edit.gid;
    }

    // We need to read the doc first to build reverse entries and handle history
    const doc = await TavernWorld.findOne({ worldId, floorId, version: expectedVersion });
    if (!doc) return null;

    // Mongoose doc.edits is a Map at runtime (schema type: Map, of: Number)
    const editsMap = doc.edits as unknown as Map<string, number>;

    // Build reverse entries from current state
    const reverse: Array<{ key: string; gid: number | null }> = [];
    for (const edit of batch) {
      const currentGid = editsMap.get(edit.key);
      reverse.push({ key: edit.key, gid: currentGid !== undefined ? currentGid : null });
    }

    const historyEntry: ITavernWorldEditHistoryEntry = {
      batchId,
      timestamp: now,
      source,
      sourceId,
      forward: batch,
      reverse,
    };

    // Apply edits to the in-memory map
    for (const edit of batch) {
      editsMap.set(edit.key, edit.gid);
    }

    // Handle history: user edits truncate at undoPointer (discard redo), agent edits preserve redo
    if (source === 'user') {
      // Truncate redo entries
      doc.editHistory.splice(doc.undoPointer);
      // Append at end
      doc.editHistory.push(historyEntry);
    } else {
      // Agent edit: insert at undoPointer position so it's the next thing to undo.
      // Redo entries (after pointer) shift right, preserving them.
      doc.editHistory.splice(doc.undoPointer, 0, historyEntry);
    }

    // Cap at MAX_HISTORY_ENTRIES, evict from front
    let evicted = 0;
    if (doc.editHistory.length > MAX_HISTORY_ENTRIES) {
      evicted = doc.editHistory.length - MAX_HISTORY_ENTRIES;
      doc.editHistory.splice(0, evicted);
    }

    // Update undoPointer: advance by 1 (new entry is now behind the pointer)
    doc.undoPointer = Math.max(0, doc.undoPointer - evicted + 1);

    doc.version = expectedVersion + 1;

    // Atomic save with version check
    const result = (await TavernWorld.findOneAndUpdate(
      { worldId, floorId, version: expectedVersion },
      {
        $set: {
          edits: doc.edits,
          editHistory: doc.editHistory,
          undoPointer: doc.undoPointer,
          version: doc.version,
        },
      },
      { new: true }
    ).lean()) as unknown as ITavernWorldDoc | null;

    return result;
  },

  /**
   * Undo the last edit. Returns updated doc + reverse edits, or null on conflict.
   */
  async undoLastEdit(
    worldId: string,
    floorId: string,
    expectedVersion: number
  ): Promise<{ doc: ITavernWorldDoc; reverseEdits: Array<{ key: string; gid: number | null }> } | null> {
    const doc = await TavernWorld.findOne({ worldId, floorId, version: expectedVersion });
    if (!doc) return null;
    if (doc.undoPointer <= 0) return null;

    const entry = doc.editHistory[doc.undoPointer - 1];
    if (!entry) return null;

    const editsMap = doc.edits as unknown as Map<string, number>;

    // Apply reverse edits to the map
    for (const rev of entry.reverse) {
      if (rev.gid === null) {
        editsMap.delete(rev.key);
      } else {
        editsMap.set(rev.key, rev.gid);
      }
    }

    const newPointer = doc.undoPointer - 1;

    const result = (await TavernWorld.findOneAndUpdate(
      { worldId, floorId, version: expectedVersion, undoPointer: doc.undoPointer },
      {
        $set: {
          edits: doc.edits,
          undoPointer: newPointer,
        },
        $inc: { version: 1 },
      },
      { new: true }
    ).lean()) as unknown as ITavernWorldDoc | null;

    if (!result) return null;
    // Convert Mongoose subdocuments to plain objects
    const reverseEdits = entry.reverse.map((r: { key: string; gid: number | null }) => ({ key: r.key, gid: r.gid }));
    return { doc: result, reverseEdits };
  },

  /**
   * Redo the last undone edit. Returns updated doc + forward edits, or null on conflict.
   */
  async redoLastEdit(
    worldId: string,
    floorId: string,
    expectedVersion: number
  ): Promise<{ doc: ITavernWorldDoc; forwardEdits: Array<{ key: string; gid: number }> } | null> {
    const doc = await TavernWorld.findOne({ worldId, floorId, version: expectedVersion });
    if (!doc) return null;
    if (doc.undoPointer >= doc.editHistory.length) return null;

    const entry = doc.editHistory[doc.undoPointer];
    if (!entry) return null;

    const editsMap = doc.edits as unknown as Map<string, number>;

    // Apply forward edits to the map
    for (const fwd of entry.forward) {
      editsMap.set(fwd.key, fwd.gid);
    }

    const newPointer = doc.undoPointer + 1;

    const result = (await TavernWorld.findOneAndUpdate(
      { worldId, floorId, version: expectedVersion, undoPointer: doc.undoPointer },
      {
        $set: {
          edits: doc.edits,
          undoPointer: newPointer,
        },
        $inc: { version: 1 },
      },
      { new: true }
    ).lean()) as unknown as ITavernWorldDoc | null;

    if (!result) return null;
    const forwardEdits = entry.forward.map((f: { key: string; gid: number }) => ({ key: f.key, gid: f.gid }));
    return { doc: result, forwardEdits };
  },

  /**
   * Reset world: clears all edits, history, resets version. Optionally sets new seed.
   */
  async resetWorld(worldId: string, floorId: string, newSeed?: number): Promise<ITavernWorldDoc | null> {
    const update: Record<string, unknown> = {
      edits: {},
      editHistory: [],
      undoPointer: 0,
      version: 0,
    };
    if (newSeed !== undefined) {
      update.seed = newSeed;
    }

    return TavernWorld.findOneAndUpdate(
      { worldId, floorId },
      { $set: update },
      { new: true }
    ).lean() as unknown as ITavernWorldDoc | null;
  },

  /**
   * Delete all floor documents for a world (used when a custom map is deleted).
   * Returns the number of documents removed.
   */
  async deleteWorld(worldId: string): Promise<number> {
    const result = await TavernWorld.deleteMany({ worldId });
    return result.deletedCount ?? 0;
  },

  /**
   * Delete all floor documents whose floorId starts with the given prefix.
   * Used to clean up dungeon sublevel docs on expiration.
   * Scoped to worldId to prevent cross-world deletions.
   */
  async deleteFloorsByPrefix(worldId: string, floorIdPrefix: string): Promise<number> {
    const result = await TavernWorld.deleteMany({
      worldId,
      floorId: { $regex: new RegExp(`^${floorIdPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) },
    });
    return result.deletedCount ?? 0;
  },
};
