import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { dungeonInstanceRepository, DungeonInstance, type DungeonInstanceCreateParams } from '../DungeonInstanceModel';

describe('DungeonInstanceModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await DungeonInstance.createIndexes();
  }, 30000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  }, 30000);

  beforeEach(async () => {
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
    }
    // dropDatabase removes indexes - rebuild so the unique partial index is enforced
    await DungeonInstance.createIndexes();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let seq = 0;
  function params(overrides: Partial<DungeonInstanceCreateParams> = {}): DungeonInstanceCreateParams {
    seq += 1;
    return {
      dungeonId: `d170000000000${seq}_ab12`,
      worldId: 'user-1',
      ownerId: 'user-1',
      numSublevels: 3,
      worldSeed: 42,
      portalCol: 44,
      portalRow: 40,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // +1h
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // createInstance
  // ---------------------------------------------------------------------------

  describe('createInstance', () => {
    it('creates an active dungeon with sensible defaults', async () => {
      const doc = await dungeonInstanceRepository.createInstance(params());

      expect(doc.status).toBe('active');
      expect(doc.spawnTrigger).toBe('manual');
      expect(doc.numSublevels).toBe(3);
      expect(doc.worldSeed).toBe(42);
      expect(doc.expiredAt).toBeUndefined();
      expect(doc.createdAt).toBeInstanceOf(Date);
    });

    it('persists optional PotionQuest content when provided', async () => {
      const doc = await dungeonInstanceRepository.createInstance(
        params({ name: 'The Plague Warrens', theme: 'undead', roomDescriptions: ['a damp hall'] })
      );

      expect(doc.name).toBe('The Plague Warrens');
      expect(doc.theme).toBe('undead');
      expect(doc.roomDescriptions).toEqual(['a damp hall']);
    });
  });

  // ---------------------------------------------------------------------------
  // Unique partial index - single active dungeon per world
  // ---------------------------------------------------------------------------

  describe('single-active-dungeon constraint', () => {
    it('rejects a second active dungeon for the same world with a duplicate-key error', async () => {
      await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000001_aaaa' }));

      await expect(
        dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000002_bbbb' }))
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows a new active dungeon once the previous one is expired', async () => {
      const first = await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000001_aaaa' }));
      await dungeonInstanceRepository.markExpired(first.dungeonId);

      // Expired docs are excluded from the partial index, so a fresh active spawn succeeds
      const second = await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000002_bbbb' }));
      expect(second.status).toBe('active');
    });

    it('allows active dungeons in different worlds simultaneously', async () => {
      await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000001_aaaa', worldId: 'user-1' }));
      const other = await dungeonInstanceRepository.createInstance(
        params({ dungeonId: 'd1700000000002_bbbb', worldId: 'user-2', ownerId: 'user-2' })
      );
      expect(other.status).toBe('active');
    });
  });

  // ---------------------------------------------------------------------------
  // getActiveDungeons
  // ---------------------------------------------------------------------------

  describe('getActiveDungeons', () => {
    it('returns only active dungeons for the given world', async () => {
      const active = await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000001_aaaa' }));
      const expiring = await dungeonInstanceRepository.createInstance(
        params({ dungeonId: 'd1700000000002_bbbb', worldId: 'user-9', ownerId: 'user-9' })
      );
      await dungeonInstanceRepository.markExpiring(expiring.dungeonId);

      const result = await dungeonInstanceRepository.getActiveDungeons('user-1');
      expect(result.map(d => d.dungeonId)).toEqual([active.dungeonId]);
    });

    it("does not return another world's dungeons", async () => {
      await dungeonInstanceRepository.createInstance(params({ worldId: 'user-2', ownerId: 'user-2' }));
      const result = await dungeonInstanceRepository.getActiveDungeons('user-1');
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getExpiredDungeons
  // ---------------------------------------------------------------------------

  describe('getExpiredDungeons', () => {
    it('returns active AND expiring dungeons past their expiry, oldest first', async () => {
      const past = new Date(Date.now() - 60 * 1000);
      const older = new Date(Date.now() - 120 * 1000);

      const a = await dungeonInstanceRepository.createInstance(
        params({ dungeonId: 'd1700000000001_aaaa', worldId: 'w-a', ownerId: 'w-a', expiresAt: past })
      );
      const b = await dungeonInstanceRepository.createInstance(
        params({ dungeonId: 'd1700000000002_bbbb', worldId: 'w-b', ownerId: 'w-b', expiresAt: older })
      );
      // b is mid-cleanup (expiring) - must still be picked up to resume a crashed run
      await dungeonInstanceRepository.markExpiring(b.dungeonId);

      const result = await dungeonInstanceRepository.getExpiredDungeons();
      expect(result.map(d => d.dungeonId)).toEqual([b.dungeonId, a.dungeonId]); // older first
    });

    it('excludes dungeons whose expiry is still in the future', async () => {
      await dungeonInstanceRepository.createInstance(params({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }));
      const result = await dungeonInstanceRepository.getExpiredDungeons();
      expect(result).toHaveLength(0);
    });

    it('excludes already-expired dungeons', async () => {
      const d = await dungeonInstanceRepository.createInstance(params({ expiresAt: new Date(Date.now() - 1000) }));
      await dungeonInstanceRepository.markExpired(d.dungeonId);
      const result = await dungeonInstanceRepository.getExpiredDungeons();
      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Status transitions (idempotency)
  // ---------------------------------------------------------------------------

  describe('markExpiring / markExpired', () => {
    it('flips active → expiring, then expiring → expired with a timestamp', async () => {
      const d = await dungeonInstanceRepository.createInstance(params());

      const expiring = await dungeonInstanceRepository.markExpiring(d.dungeonId);
      expect(expiring?.status).toBe('expiring');

      const expired = await dungeonInstanceRepository.markExpired(d.dungeonId);
      expect(expired?.status).toBe('expired');
      expect(expired?.expiredAt).toBeInstanceOf(Date);
    });

    it('markExpiring is a no-op once the dungeon is no longer active', async () => {
      const d = await dungeonInstanceRepository.createInstance(params());
      await dungeonInstanceRepository.markExpiring(d.dungeonId);

      // second call finds nothing matching { status: 'active' }
      const again = await dungeonInstanceRepository.markExpiring(d.dungeonId);
      expect(again).toBeNull();
    });

    it('is fully idempotent across a repeated expire sequence', async () => {
      const d = await dungeonInstanceRepository.createInstance(params());

      // Simulate a crashed-and-retried cleanup: run the transition pair twice
      await dungeonInstanceRepository.markExpiring(d.dungeonId);
      await dungeonInstanceRepository.markExpired(d.dungeonId);
      await dungeonInstanceRepository.markExpiring(d.dungeonId); // null
      const finalExpired = await dungeonInstanceRepository.markExpired(d.dungeonId); // null — already expired

      expect(finalExpired).toBeNull();
      const persisted = await dungeonInstanceRepository.findByDungeonId(d.dungeonId);
      expect(persisted?.status).toBe('expired');
    });
  });

  // ---------------------------------------------------------------------------
  // findMostRecent / updateContent
  // ---------------------------------------------------------------------------

  describe('findMostRecent', () => {
    it('returns the most recently created dungeon for the world regardless of status', async () => {
      const first = await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000001_aaaa' }));
      await dungeonInstanceRepository.markExpired(first.dungeonId);
      const second = await dungeonInstanceRepository.createInstance(params({ dungeonId: 'd1700000000002_bbbb' }));

      const recent = await dungeonInstanceRepository.findMostRecent('user-1');
      expect(recent?.dungeonId).toBe(second.dungeonId);
    });

    it('returns null when the world has never had a dungeon', async () => {
      const recent = await dungeonInstanceRepository.findMostRecent('nobody');
      expect(recent).toBeNull();
    });
  });

  describe('updateContent', () => {
    it('merges PotionQuest content onto an existing dungeon', async () => {
      const d = await dungeonInstanceRepository.createInstance(params());

      const updated = await dungeonInstanceRepository.updateContent(d.dungeonId, {
        name: 'The Sunken Crypts',
        theme: 'aquatic',
        roomDescriptions: ['a flooded antechamber'],
      });

      expect(updated?.name).toBe('The Sunken Crypts');
      expect(updated?.theme).toBe('aquatic');
      expect(updated?.roomDescriptions).toEqual(['a flooded antechamber']);
      expect(updated?.status).toBe('active'); // unchanged
    });
  });
});
