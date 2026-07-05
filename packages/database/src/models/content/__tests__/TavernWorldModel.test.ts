import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { tavernWorldRepository, TavernWorld } from '../TavernWorldModel';

describe('TavernWorldModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await TavernWorld.createIndexes();
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Shorthand: create a world and return it */
  async function createWorld(worldId = 'user-1', ownerId = 'user-1') {
    return tavernWorldRepository.getOrCreateWorld(worldId, ownerId);
  }

  /** Shorthand: apply a named batch of edits */
  async function applyEdits(
    worldId: string,
    version: number,
    edits: Array<{ key: string; gid: number }>,
    source: 'user' | 'agent' = 'user'
  ) {
    return tavernWorldRepository.applyEdits(worldId, 'surface', version, edits, source);
  }

  // ---------------------------------------------------------------------------
  // getOrCreateWorld
  // ---------------------------------------------------------------------------

  describe('getOrCreateWorld', () => {
    it('should create a new world with defaults', async () => {
      const doc = await createWorld();

      expect(doc.worldId).toBe('user-1');
      expect(doc.ownerId).toBe('user-1');
      expect(doc.floorId).toBe('surface');
      expect(doc.seed).toBeGreaterThanOrEqual(1);
      expect(doc.seed).toBeLessThanOrEqual(999999);
      expect(doc.generatorVersion).toBe(1);
      expect(doc.version).toBe(0);
      expect(doc.undoPointer).toBe(0);
      expect(doc.editHistory).toHaveLength(0);
    });

    it('should return existing world on second call', async () => {
      const first = await createWorld();
      const second = await createWorld();

      expect(first._id.toString()).toBe(second._id.toString());
      expect(first.seed).toBe(second.seed);
    });

    it('should create separate worlds for different worldIds', async () => {
      const w1 = await createWorld('user-1');
      const w2 = await createWorld('user-2');

      expect(w1._id.toString()).not.toBe(w2._id.toString());
    });

    it('should enforce unique constraint on worldId+floorId', async () => {
      await createWorld('user-1');
      // Same worldId + floorId should not create a duplicate
      const count = await TavernWorld.countDocuments({ worldId: 'user-1', floorId: 'surface' });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // applyEdits - basic functionality
  // ---------------------------------------------------------------------------

  describe('applyEdits', () => {
    it('should apply edits and increment version', async () => {
      await createWorld();

      const result = await applyEdits('user-1', 0, [
        { key: 'furniture:10,20', gid: 1253 },
        { key: 'decoration:5,5', gid: 42 },
      ]);

      expect(result).not.toBeNull();
      expect(result!.version).toBe(1);
      expect(result!.edits['furniture:10,20']).toBe(1253);
      expect(result!.edits['decoration:5,5']).toBe(42);
    });

    it('should create history entry with forward and reverse', async () => {
      await createWorld();

      const result = await applyEdits('user-1', 0, [{ key: 'furniture:10,20', gid: 100 }]);

      expect(result!.editHistory).toHaveLength(1);
      const entry = result!.editHistory[0];
      expect(entry.source).toBe('user');
      expect(entry.forward).toEqual([{ key: 'furniture:10,20', gid: 100 }]);
      expect(entry.reverse).toEqual([{ key: 'furniture:10,20', gid: null }]); // was empty
    });

    it('should record previous gid in reverse entries', async () => {
      await createWorld();

      // Place a tile
      await applyEdits('user-1', 0, [{ key: 'furniture:10,20', gid: 100 }]);

      // Overwrite it
      const result = await applyEdits('user-1', 1, [{ key: 'furniture:10,20', gid: 200 }]);

      const entry = result!.editHistory[1];
      expect(entry.reverse).toEqual([{ key: 'furniture:10,20', gid: 100 }]); // was 100
      expect(entry.forward).toEqual([{ key: 'furniture:10,20', gid: 200 }]);
    });

    it('should set undoPointer to end of history for user edits', async () => {
      await createWorld();

      const r1 = await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);
      expect(r1!.undoPointer).toBe(1);

      const r2 = await applyEdits('user-1', 1, [{ key: 'ground:1,1', gid: 2 }]);
      expect(r2!.undoPointer).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // applyEdits - optimistic concurrency
  // ---------------------------------------------------------------------------

  describe('applyEdits — concurrency', () => {
    it('should return null on version mismatch (409)', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);

      // Try to apply with stale version
      const result = await applyEdits('user-1', 0, [{ key: 'ground:1,1', gid: 2 }]);
      expect(result).toBeNull();
    });

    it('should succeed with correct version after previous edit', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);

      const result = await applyEdits('user-1', 1, [{ key: 'ground:1,1', gid: 2 }]);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // applyEdits - validation
  // ---------------------------------------------------------------------------

  describe('applyEdits — validation', () => {
    it('should reject batch exceeding 2000 edits', async () => {
      await createWorld();

      const bigBatch = Array.from({ length: 2001 }, (_, i) => ({
        key: `ground:${i % 96},${Math.floor(i / 96)}`,
        gid: 1,
      }));

      await expect(applyEdits('user-1', 0, bigBatch)).rejects.toThrow(/exceeds maximum/);
    });

    it('should reject invalid layer name', async () => {
      await createWorld();

      await expect(applyEdits('user-1', 0, [{ key: 'invalid_layer:0,0', gid: 1 }])).rejects.toThrow(/Invalid edit key/);
    });

    it('should reject out-of-bounds coordinates', async () => {
      await createWorld();

      await expect(applyEdits('user-1', 0, [{ key: 'ground:96,0', gid: 1 }])).rejects.toThrow(/Invalid edit key/);
    });

    it('should reject negative gid', async () => {
      await createWorld();

      await expect(applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: -1 }])).rejects.toThrow(/Invalid gid/);
    });

    it('should accept gid of 0 (clear tile)', async () => {
      await createWorld();

      const result = await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 0 }]);
      expect(result).not.toBeNull();
      expect(result!.edits['ground:0,0']).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // applyEdits - history cap
  // ---------------------------------------------------------------------------

  describe('applyEdits — history cap', () => {
    it('should cap editHistory at 500 entries', async () => {
      await createWorld();

      // Apply edits in bulk batches to stay under timeout
      // Each applyEdits call is one history entry, so we need 500+ calls
      // Use a smaller batch to verify the cap mechanism works
      for (let i = 0; i < 500; i++) {
        await applyEdits('user-1', i, [{ key: `ground:${i % 96},0`, gid: i + 1 }]);
      }

      // Apply one more - should evict oldest
      const result = await applyEdits('user-1', 500, [{ key: 'ground:0,1', gid: 999 }]);
      expect(result!.editHistory).toHaveLength(500);
      expect(result!.version).toBe(501);
    }, 120000);

    it('should adjust undoPointer when entries are evicted', async () => {
      await createWorld();

      // Fill history to 500
      for (let i = 0; i < 500; i++) {
        await applyEdits('user-1', i, [{ key: `ground:${i % 96},0`, gid: i + 1 }]);
      }

      // Pointer should be at 500
      const before = await tavernWorldRepository.getOrCreateWorld('user-1', 'user-1');
      expect(before.undoPointer).toBe(500);

      // Add one more - evicts 1 from front
      const result = await applyEdits('user-1', 500, [{ key: 'ground:0,1', gid: 999 }]);
      expect(result!.editHistory).toHaveLength(500);
      // Pointer should still be at end (500), not 501
      expect(result!.undoPointer).toBe(500);
    }, 120000);
  });

  // ---------------------------------------------------------------------------
  // undoLastEdit
  // ---------------------------------------------------------------------------

  describe('undoLastEdit', () => {
    it('should undo the last edit and return reverse edits', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'furniture:10,20', gid: 100 }]);

      const result = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 1);

      expect(result).not.toBeNull();
      expect(result!.doc.version).toBe(2);
      expect(result!.doc.undoPointer).toBe(0);
      expect(result!.reverseEdits).toEqual([{ key: 'furniture:10,20', gid: null }]);
      // The edit should be removed from the edits map
      expect(result!.doc.edits['furniture:10,20']).toBeUndefined();
    });

    it('should restore previous gid on undo', async () => {
      await createWorld();
      // Place original tile
      await applyEdits('user-1', 0, [{ key: 'furniture:10,20', gid: 100 }]);
      // Overwrite with new tile
      await applyEdits('user-1', 1, [{ key: 'furniture:10,20', gid: 200 }]);

      // Undo the overwrite
      const result = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 2);

      expect(result!.doc.edits['furniture:10,20']).toBe(100); // restored to original
      expect(result!.reverseEdits).toEqual([{ key: 'furniture:10,20', gid: 100 }]);
    });

    it('should return null when nothing to undo (pointer at 0)', async () => {
      await createWorld();

      const result = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 0);
      expect(result).toBeNull();
    });

    it('should return null on version mismatch', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);

      const result = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 0); // stale version
      expect(result).toBeNull();
    });

    it('should support multiple sequential undos', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 10 }]);
      await applyEdits('user-1', 1, [{ key: 'ground:1,1', gid: 20 }]);

      // Undo second edit
      const r1 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 2);
      expect(r1!.doc.undoPointer).toBe(1);
      expect(r1!.doc.edits['ground:1,1']).toBeUndefined();
      expect(r1!.doc.edits['ground:0,0']).toBe(10); // first edit still there

      // Undo first edit
      const r2 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 3);
      expect(r2!.doc.undoPointer).toBe(0);
      expect(r2!.doc.edits['ground:0,0']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // redoLastEdit
  // ---------------------------------------------------------------------------

  describe('redoLastEdit', () => {
    it('should redo an undone edit', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'furniture:5,5', gid: 50 }]);

      // Undo
      await tavernWorldRepository.undoLastEdit('user-1', 'surface', 1);

      // Redo
      const result = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 2);

      expect(result).not.toBeNull();
      expect(result!.doc.edits['furniture:5,5']).toBe(50);
      expect(result!.doc.undoPointer).toBe(1);
      expect(result!.forwardEdits).toEqual([{ key: 'furniture:5,5', gid: 50 }]);
    });

    it('should return null when nothing to redo', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);

      // No undo was done, pointer is at end
      const result = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 1);
      expect(result).toBeNull();
    });

    it('should support undo then redo then undo cycle', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 42 }]);

      // Undo
      const r1 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 1);
      expect(r1!.doc.edits['ground:0,0']).toBeUndefined();

      // Redo
      const r2 = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 2);
      expect(r2!.doc.edits['ground:0,0']).toBe(42);

      // Undo again
      const r3 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 3);
      expect(r3!.doc.edits['ground:0,0']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // User edit truncates redo
  // ---------------------------------------------------------------------------

  describe('user edit truncates redo', () => {
    it('should discard redo entries when user makes a new edit after undo', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 10 }]);
      await applyEdits('user-1', 1, [{ key: 'ground:1,1', gid: 20 }]);

      // Undo the second edit (pointer goes to 1, redo available)
      await tavernWorldRepository.undoLastEdit('user-1', 'surface', 2);

      // Make a new edit - this should truncate the redo entry
      const result = await applyEdits('user-1', 3, [{ key: 'ground:2,2', gid: 30 }]);

      expect(result!.editHistory).toHaveLength(2); // edit 0 + new edit, redo entry discarded
      expect(result!.undoPointer).toBe(2);

      // Redo should fail - nothing to redo
      const redo = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 4);
      expect(redo).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Agent edits interleaved with user undo
  // ---------------------------------------------------------------------------

  describe('agent edits interleaved with user undo', () => {
    it('should preserve redo entries when agent edits arrive', async () => {
      await createWorld();

      // User makes 5 edits
      for (let i = 0; i < 5; i++) {
        await applyEdits('user-1', i, [{ key: `ground:${i},0`, gid: (i + 1) * 10 }]);
      }
      // History: [edit0, edit1, edit2, edit3, edit4], pointer=5

      // User undoes 2 (pointer goes to 3)
      await tavernWorldRepository.undoLastEdit('user-1', 'surface', 5); // undo edit4, pointer=4
      await tavernWorldRepository.undoLastEdit('user-1', 'surface', 6); // undo edit3, pointer=3

      // Verify pointer is at 3 and we have redo entries
      const beforeAgent = await tavernWorldRepository.getOrCreateWorld('user-1', 'user-1');
      expect(beforeAgent.undoPointer).toBe(3);
      expect(beforeAgent.editHistory).toHaveLength(5); // all 5 still in history

      // Agent makes an edit - should NOT truncate redo
      const agentResult = await applyEdits('user-1', 7, [{ key: 'decoration:50,50', gid: 999 }], 'agent');

      expect(agentResult).not.toBeNull();
      // History should now have 6 entries (5 original + 1 agent)
      expect(agentResult!.editHistory).toHaveLength(6);
      // Pointer should advance by 1 (agent edit is undoable)
      expect(agentResult!.undoPointer).toBe(4);

      // User undoes - should undo the agent edit
      const undoAgent = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 8);
      expect(undoAgent).not.toBeNull();
      expect(undoAgent!.doc.edits['decoration:50,50']).toBeUndefined();
      expect(undoAgent!.doc.undoPointer).toBe(3);

      // The original 2 redo entries should still be accessible
      // Redo should give back the agent edit (it's at position 3)
      const redoAgent = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 9);
      expect(redoAgent).not.toBeNull();
      expect(redoAgent!.doc.edits['decoration:50,50']).toBe(999);

      // Can redo past agent edit to the original redo entries
      const redoEdit3 = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 10);
      expect(redoEdit3).not.toBeNull();
      expect(redoEdit3!.doc.edits['ground:3,0']).toBe(40); // edit3 restored

      const redoEdit4 = await tavernWorldRepository.redoLastEdit('user-1', 'surface', 11);
      expect(redoEdit4).not.toBeNull();
      expect(redoEdit4!.doc.edits['ground:4,0']).toBe(50); // edit4 restored
    });

    it('agent edit should be undoable independently', async () => {
      await createWorld();

      // User makes 2 edits
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 10 }]);
      await applyEdits('user-1', 1, [{ key: 'ground:1,1', gid: 20 }]);

      // Agent makes an edit
      await applyEdits('user-1', 2, [{ key: 'decoration:10,10', gid: 500 }], 'agent');

      // Undo agent edit
      const r1 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 3);
      expect(r1!.doc.edits['decoration:10,10']).toBeUndefined();
      expect(r1!.doc.edits['ground:0,0']).toBe(10); // user edits intact
      expect(r1!.doc.edits['ground:1,1']).toBe(20);

      // Undo user edit
      const r2 = await tavernWorldRepository.undoLastEdit('user-1', 'surface', 4);
      expect(r2!.doc.edits['ground:1,1']).toBeUndefined();
      expect(r2!.doc.edits['ground:0,0']).toBe(10); // first user edit still intact
    });
  });

  // ---------------------------------------------------------------------------
  // resetWorld
  // ---------------------------------------------------------------------------

  describe('resetWorld', () => {
    it('should clear all edits and history', async () => {
      await createWorld();
      await applyEdits('user-1', 0, [{ key: 'ground:0,0', gid: 1 }]);

      const result = await tavernWorldRepository.resetWorld('user-1', 'surface');

      expect(result).not.toBeNull();
      expect(result!.version).toBe(0);
      expect(result!.undoPointer).toBe(0);
      expect(result!.editHistory).toHaveLength(0);
      expect(Object.keys(result!.edits)).toHaveLength(0);
    });

    it('should update seed when provided', async () => {
      await createWorld();

      const result = await tavernWorldRepository.resetWorld('user-1', 'surface', 12345);

      expect(result!.seed).toBe(12345);
    });

    it('should preserve existing seed when not provided', async () => {
      await createWorld();

      const result = await tavernWorldRepository.resetWorld('user-1', 'surface');

      // seed preserved from initial creation (random, but unchanged by reset)
      const original = await tavernWorldRepository.getOrCreateWorld('user-1', 'user-1');
      expect(result!.seed).toBe(original.seed);
    });

    it('should return null for non-existent world', async () => {
      const result = await tavernWorldRepository.resetWorld('nonexistent', 'surface');
      expect(result).toBeNull();
    });
  });
});
