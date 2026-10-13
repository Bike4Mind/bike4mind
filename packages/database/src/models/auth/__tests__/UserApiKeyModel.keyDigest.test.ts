import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from '../UserApiKeyModel';
import { ApiKeyScope } from '@bike4mind/common';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UserApiKey.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await UserApiKey.deleteMany({});
});

const base = {
  userId: 'user-1',
  name: 'key',
  keyHash: '$2b$12$abcdefghijklmnopqrstuv',
  scopes: [ApiKeyScope.AI_CHAT],
  metadata: { createdFrom: 'dashboard' as const },
};

const DIGEST = 'a'.repeat(64);

describe('UserApiKeyModel keyDigest', () => {
  it('stores a doc with a keyDigest and no keyHash', async () => {
    const { keyHash: _legacyHash, ...digestOnly } = base;

    const created = await UserApiKey.create({ ...digestOnly, keyPrefix: 'b4m_live_nohash01', keyDigest: DIGEST });

    const found = await userApiKeyRepository.findActiveByKeyPrefix('b4m_live_nohash01');
    expect(found?.id).toBe(created.id);
    expect(found?.keyDigest).toBe(DIGEST);
    expect(found?.keyHash).toBeUndefined();
  });

  it('setKeyDigest persists the digest so the prefix lookup returns it', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_digest01' });
    expect(created.keyDigest).toBeUndefined();

    await userApiKeyRepository.setKeyDigest(created.id, DIGEST, base.keyHash);

    const found = await userApiKeyRepository.findActiveByKeyPrefix('b4m_live_digest01');
    expect(found?.keyDigest).toBe(DIGEST);
  });

  // validate.ts heals a key after a slow bcrypt compare. If a rotation commits in that window, the
  // late writes must miss: otherwise they repoint the doc at the rotated-away key.
  describe('heals racing a rotation', () => {
    const ROTATED_HASH = '$2b$12$rotatedrotatedrotatedr';
    const ROTATED_DIGEST = 'b'.repeat(64);

    async function rotatedKey(tag: string) {
      const created = await UserApiKey.create({ ...base, keyPrefix: `b4m_live_old${tag}` });
      await userApiKeyRepository.update({
        id: created.id,
        keyHash: ROTATED_HASH,
        keyDigest: ROTATED_DIGEST,
        keyPrefix: `b4m_live_new${tag}`,
      });
      return created.id;
    }

    it('setKeyDigest does not overwrite the rotated key digest', async () => {
      const id = await rotatedKey('dg');

      await userApiKeyRepository.setKeyDigest(id, DIGEST, base.keyHash);

      expect((await UserApiKey.findById(id))?.keyDigest).toBe(ROTATED_DIGEST);
    });

    // An instance still on pre-digest code rotates without writing a digest (a rolling deploy), so
    // the empty-digest filter alone would let the late backfill store D(K1) beside H(K2).
    it('setKeyDigest does not backfill a key rotated without a digest', async () => {
      const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_oldnd' });
      await userApiKeyRepository.update({ id: created.id, keyHash: ROTATED_HASH, keyPrefix: 'b4m_live_newnd' });

      await userApiKeyRepository.setKeyDigest(created.id, DIGEST, base.keyHash);

      expect((await UserApiKey.findById(created.id))?.keyDigest).toBeUndefined();
    });

    it('healKeyPrefix does not repoint the rotated key prefix', async () => {
      const id = await rotatedKey('px');

      await userApiKeyRepository.healKeyPrefix(id, 'b4m_live_oldpx_heal', { keyHash: base.keyHash });

      expect((await UserApiKey.findById(id))?.keyPrefix).toBe('b4m_live_newpx');
    });

    it('healKeyPrefix applies while the validated hash is still stored', async () => {
      const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_legacy1' });

      await userApiKeyRepository.healKeyPrefix(created.id, 'b4m_live_legacy1_heal', {
        keyHash: base.keyHash,
      });

      expect((await UserApiKey.findById(created.id))?.keyPrefix).toBe('b4m_live_legacy1_heal');
    });

    it('healKeyPrefix applies to a digest-only key while its digest is still stored', async () => {
      const { keyHash: _legacyHash, ...digestOnly } = base;
      const created = await UserApiKey.create({ ...digestOnly, keyPrefix: 'b4m_live_digonly1', keyDigest: DIGEST });

      await userApiKeyRepository.healKeyPrefix(created.id, 'b4m_live_digonly1_heal', { keyDigest: DIGEST });

      expect((await UserApiKey.findById(created.id))?.keyPrefix).toBe('b4m_live_digonly1_heal');
    });

    it('healKeyPrefix does not repoint a digest-only key once its digest rotated', async () => {
      const { keyHash: _legacyHash, ...digestOnly } = base;
      const created = await UserApiKey.create({ ...digestOnly, keyPrefix: 'b4m_live_digonly2', keyDigest: DIGEST });
      await userApiKeyRepository.update({ id: created.id, keyDigest: ROTATED_DIGEST, keyPrefix: 'b4m_live_newdo2' });

      await userApiKeyRepository.healKeyPrefix(created.id, 'b4m_live_digonly2_heal', { keyDigest: DIGEST });

      expect((await UserApiKey.findById(created.id))?.keyPrefix).toBe('b4m_live_newdo2');
    });

    it('update with unset removes the legacy keyHash, so a heal keyed on it no longer lands', async () => {
      const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_unset01' });
      await userApiKeyRepository.update(
        { id: created.id, keyDigest: ROTATED_DIGEST, keyPrefix: 'b4m_live_unset02' },
        { unset: ['keyHash'] }
      );

      const rotated = await UserApiKey.findById(created.id).lean();
      expect(rotated).not.toHaveProperty('keyHash');
      expect(rotated?.keyDigest).toBe(ROTATED_DIGEST);

      await userApiKeyRepository.healKeyPrefix(created.id, 'b4m_live_unset01_heal', { keyHash: base.keyHash });

      expect((await UserApiKey.findById(created.id))?.keyPrefix).toBe('b4m_live_unset02');
    });
  });

  it('setKeyDigest never replaces a digest that is already set', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_digest03', keyDigest: DIGEST });

    await userApiKeyRepository.setKeyDigest(created.id, 'c'.repeat(64), base.keyHash);

    expect((await UserApiKey.findById(created.id))?.keyDigest).toBe(DIGEST);
  });

  it('strips keyDigest (and keyHash) from toJSON, the serializer every API response uses', async () => {
    await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_digest02', keyDigest: DIGEST });

    const [listed] = await userApiKeyRepository.findByUserId('user-1');
    const json = listed.toJSON() as Record<string, unknown>;
    expect('keyDigest' in json).toBe(false);
    expect('keyHash' in json).toBe(false);
    expect(JSON.stringify(listed)).not.toContain(DIGEST);
  });
});
