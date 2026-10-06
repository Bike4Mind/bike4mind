import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, ApiKeyStatus, CreditHolderType, IUserApiKeyDocument } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { userApiKeyRepository, UserApiKey } from '@bike4mind/database';
import { userApiKeyService } from '@bike4mind/services';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Proves the userApiKeyService writers persist only the fields they change, against the REAL
 * repository and Mongo: a revoke/deactivate or spend $inc that lands between a writer's read and
 * its write must survive. The interleaving is forced by wrapping the repo's read so the racing
 * write runs right after it, then the (now stale) doc is handed back. Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const baseDb = {
  agents: { findById: async () => ({ organizationId: 'org-1', userId: 'owner-1' }) },
  organizations: { findIdsAdministeredBy: async () => [] },
};

const mintEmbedKey = () =>
  userApiKeyService.createUserApiKey(
    'owner-1',
    {
      name: 'widget key',
      scopes: [ApiKeyScope.EMBED_CHAT],
      metadata: { createdFrom: 'dashboard' as const },
      agentId: 'agent-1',
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'org-1',
      allowedOrigins: ['https://old.example.com'],
    },
    { db: { ...baseDb, userApiKeys: userApiKeyRepository } }
  );

const race = async (keyId: string, spend: number, deactivate: boolean) => {
  if (deactivate) await userApiKeyRepository.deactivateAllByUserId('owner-1');
  await userApiKeyRepository.incrementSpend(keyId, spend);
};

// Object.create keeps the real repo's prototype methods and `this` binding.
const racingOwnedReadRepo = (spend: number, deactivate: boolean) => {
  const repo = Object.create(userApiKeyRepository) as typeof userApiKeyRepository;
  repo.findByUserIdAndId = async (userId: string, id: string) => {
    const doc = await userApiKeyRepository.findByUserIdAndId(userId, id);
    await race(id, spend, deactivate);
    return doc;
  };
  return repo;
};

const reload = (id: string) => UserApiKey.findById(id).lean<IUserApiKeyDocument>();

describe('userApiKeyService writers vs concurrent writes (real repo + Mongo)', () => {
  it('validate self-heal does not re-activate a key deactivated mid-flight or reset its spend', async () => {
    const minted = await mintEmbedKey();
    const currentPrefix = minted.key.substring(0, minted.keyPrefix.length);
    // Downgrade to the legacy 12-char stored prefix so validation takes the self-heal path.
    await UserApiKey.updateOne({ _id: minted.id }, { $set: { keyPrefix: minted.key.substring(0, 12) } });

    let healed: Promise<unknown> | undefined;
    const repo = Object.create(userApiKeyRepository) as typeof userApiKeyRepository;
    repo.findActiveByKeyPrefix = async (prefix: string) => {
      const doc = await userApiKeyRepository.findActiveByKeyPrefix(prefix);
      if (doc) await race(minted.id, 7, true);
      return doc;
    };
    repo.healKeyPrefix = (id: string, keyPrefix: string, expectedKeyHash: string) => {
      const p = userApiKeyRepository.healKeyPrefix(id, keyPrefix, expectedKeyHash);
      healed = p;
      return p;
    };

    const result = await userApiKeyService.validateUserApiKey(minted.key, { db: { userApiKeys: repo } });
    expect(result.isValid).toBe(true); // the stale read itself still passes; only the persisted revert is fixed
    expect(healed).toBeDefined();
    await healed;

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.DISABLED);
    expect(after!.revokedAt).toBeInstanceOf(Date);
    expect(after!.usage.totalSpendCredits).toBe(7);
    expect(after!.keyPrefix).toBe(currentPrefix);
  });

  it('revoke keeps a spend increment that lands after its read', async () => {
    const minted = await mintEmbedKey();

    await userApiKeyService.revokeUserApiKey(
      'owner-1',
      { keyId: minted.id },
      { db: { ...baseDb, userApiKeys: racingOwnedReadRepo(5, false) } }
    );

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.DISABLED);
    expect(after!.revokedBy).toBe('owner-1');
    expect(after!.usage.totalSpendCredits).toBe(5);
  });

  it('revoke racing a ban keeps the ban audit stamp instead of overwriting it', async () => {
    const minted = await mintEmbedKey();

    await userApiKeyService.revokeUserApiKey(
      'owner-1',
      { keyId: minted.id, reason: 'late revoke' },
      { db: { ...baseDb, userApiKeys: racingOwnedReadRepo(1, true) } }
    );

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.DISABLED);
    expect(after!.revokedAt).toBeInstanceOf(Date);
    expect(after!.revokedBy).toBeUndefined();
    expect(after!.revokedReason).toBeUndefined();
  });

  it('re-revoking keeps the first revocation', async () => {
    const minted = await mintEmbedKey();
    const db = { ...baseDb, userApiKeys: userApiKeyRepository };

    await userApiKeyService.revokeUserApiKey('owner-1', { keyId: minted.id, reason: 'first' }, { db });
    const first = await reload(minted.id);
    await userApiKeyService.revokeUserApiKey('owner-1', { keyId: minted.id, reason: 'second' }, { db });

    const after = await reload(minted.id);
    expect(after!.revokedReason).toBe('first');
    expect(after!.revokedAt).toEqual(first!.revokedAt);
  });

  it('rotate does not resurrect a key deactivated mid-flight or reset its spend', async () => {
    const minted = await mintEmbedKey();
    const before = await reload(minted.id);

    await userApiKeyService.rotateUserApiKey(
      'owner-1',
      { keyId: minted.id },
      { db: { ...baseDb, userApiKeys: racingOwnedReadRepo(9, true) } }
    );

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.DISABLED);
    expect(after!.usage.totalSpendCredits).toBe(9);
    expect(after!.keyHash).not.toBe(before!.keyHash);
  });

  it('updateEmbedKey does not resurrect a key deactivated mid-flight or reset its spend', async () => {
    const minted = await mintEmbedKey();

    await userApiKeyService.updateEmbedKey(
      'owner-1',
      { keyId: minted.id, allowedOrigins: ['https://new.example.com'] },
      { db: { ...baseDb, userApiKeys: racingOwnedReadRepo(3, true) } }
    );

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.DISABLED);
    expect(after!.usage.totalSpendCredits).toBe(3);
    expect(after!.allowedOrigins).toEqual(['https://new.example.com']);
  });

  it('control: a whole-document write of the stale doc DOES revert both (the hazard the writers avoid)', async () => {
    const minted = await mintEmbedKey();
    const stale = await userApiKeyRepository.findByUserIdAndId('owner-1', minted.id);
    await race(minted.id, 4, true);

    await userApiKeyRepository.update(stale!);

    const after = await reload(minted.id);
    expect(after!.status).toBe(ApiKeyStatus.ACTIVE);
    expect(after!.usage.totalSpendCredits).toBe(0);
  });
});
