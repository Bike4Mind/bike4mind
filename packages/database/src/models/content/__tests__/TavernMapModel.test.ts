import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import {
  tavernMapRepository,
  TavernMap,
  DEFAULT_FLOOR_TILE_GID,
  MAX_CUSTOM_MAPS_PER_USER,
  MIN_MAP_DIM,
  MAX_MAP_DIM,
} from '../TavernMapModel';

describe('TavernMapModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await TavernMap.createIndexes();
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
  // listMaps - lazy tavern seed
  // ---------------------------------------------------------------------------

  describe('listMaps', () => {
    it('lazily seeds a tavern entry on first access', async () => {
      const maps = await tavernMapRepository.listMaps('user-1');
      expect(maps).toHaveLength(1);
      expect(maps[0].kind).toBe('tavern');
      expect(maps[0].mapId).toBe('user-1');
      expect(maps[0].name).toBe('The Tavern');
      expect(maps[0].widthTiles).toBe(96);
      expect(maps[0].heightTiles).toBe(96);
    });

    it('does not create a second tavern entry on repeated calls', async () => {
      await tavernMapRepository.listMaps('user-1');
      await tavernMapRepository.listMaps('user-1');
      const count = await TavernMap.countDocuments({ ownerId: 'user-1', kind: 'tavern' });
      expect(count).toBe(1);
    });

    it('returns the tavern first, then custom maps', async () => {
      await tavernMapRepository.listMaps('user-1');
      await tavernMapRepository.createMap('user-1', 'map-a', 'Forest', 16, 16);
      const maps = await tavernMapRepository.listMaps('user-1');
      expect(maps).toHaveLength(2);
      expect(maps[0].kind).toBe('tavern');
      expect(maps[1].kind).toBe('custom');
      expect(maps[1].name).toBe('Forest');
    });

    it('scopes maps to the owner', async () => {
      await tavernMapRepository.createMap('user-1', 'm1', 'Mine', 24, 24);
      const otherMaps = await tavernMapRepository.listMaps('user-2');
      expect(otherMaps.every(m => m.ownerId === 'user-2')).toBe(true);
      expect(otherMaps.find(m => m.mapId === 'm1')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // createMap - validation + quota
  // ---------------------------------------------------------------------------

  describe('createMap', () => {
    it('creates a custom map with rectangular (non-square) dimensions', async () => {
      const map = await tavernMapRepository.createMap('user-1', 'm1', 'Dungeon', 30, 20);
      expect(map.kind).toBe('custom');
      expect(map.widthTiles).toBe(30);
      expect(map.heightTiles).toBe(20);
      expect(map.floorTileGid).toBe(DEFAULT_FLOOR_TILE_GID);
    });

    it('trims the name', async () => {
      const map = await tavernMapRepository.createMap('user-1', 'm1', '  Spaced  ', 16, 16);
      expect(map.name).toBe('Spaced');
    });

    it('rejects an empty name', async () => {
      await expect(tavernMapRepository.createMap('user-1', 'm1', '   ', 16, 16)).rejects.toThrow(/Invalid map name/);
    });

    it('rejects out-of-range or non-integer dimensions', async () => {
      await expect(tavernMapRepository.createMap('user-1', 'm1', 'Too big', MAX_MAP_DIM + 1, 16)).rejects.toThrow(
        /Invalid map dimensions/
      );
      await expect(tavernMapRepository.createMap('user-1', 'm2', 'Too small', 16, MIN_MAP_DIM - 1)).rejects.toThrow(
        /Invalid map dimensions/
      );
      await expect(tavernMapRepository.createMap('user-1', 'm3', 'Fractional', 16.5, 16)).rejects.toThrow(
        /Invalid map dimensions/
      );
    });

    it('enforces the per-user quota', async () => {
      for (let i = 0; i < MAX_CUSTOM_MAPS_PER_USER; i++) {
        await tavernMapRepository.createMap('user-1', `m${i}`, `Map ${i}`, 16, 16);
      }
      await expect(tavernMapRepository.createMap('user-1', 'overflow', 'Too many', 16, 16)).rejects.toThrow(
        /quota exceeded/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // deleteMap
  // ---------------------------------------------------------------------------

  describe('deleteMap', () => {
    it('deletes a custom map owned by the user', async () => {
      await tavernMapRepository.createMap('user-1', 'm1', 'Temp', 16, 16);
      const ok = await tavernMapRepository.deleteMap('m1', 'user-1');
      expect(ok).toBe(true);
      expect(await tavernMapRepository.getMap('m1')).toBeNull();
    });

    it("refuses to delete another user's map", async () => {
      await tavernMapRepository.createMap('user-1', 'm1', 'Temp', 16, 16);
      const ok = await tavernMapRepository.deleteMap('m1', 'user-2');
      expect(ok).toBe(false);
      expect(await tavernMapRepository.getMap('m1')).not.toBeNull();
    });

    it('refuses to delete the tavern entry', async () => {
      await tavernMapRepository.listMaps('user-1'); // seeds tavern (mapId === user-1)
      const ok = await tavernMapRepository.deleteMap('user-1', 'user-1');
      expect(ok).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // assertOwnership - the IDOR guard
  // ---------------------------------------------------------------------------

  describe('assertOwnership', () => {
    it('always allows the tavern (mapId === userId) without a metadata doc', async () => {
      const { ok } = await tavernMapRepository.assertOwnership('user-1', 'user-1');
      expect(ok).toBe(true);
    });

    it('allows the owner of a custom map', async () => {
      await tavernMapRepository.createMap('user-1', 'm1', 'Mine', 16, 16);
      const { ok } = await tavernMapRepository.assertOwnership('m1', 'user-1');
      expect(ok).toBe(true);
    });

    it('denies a non-owner', async () => {
      await tavernMapRepository.createMap('user-1', 'm1', 'Mine', 16, 16);
      const { ok } = await tavernMapRepository.assertOwnership('m1', 'user-2');
      expect(ok).toBe(false);
    });

    it('denies an unknown map', async () => {
      const { ok } = await tavernMapRepository.assertOwnership('does-not-exist', 'user-1');
      expect(ok).toBe(false);
    });
  });
});
