import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';
import { UserApiKey, userApiKeyRepository } from '../UserApiKeyModel';
import { ApiKeyScope, ApiKeyStatus } from '@bike4mind/common';
import { configureSecretsAtRest, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await UserApiKey.syncIndexes();
  // Configured once for the whole file; vitest gives each test file its own module registry,
  // so this does not leak into other suites (see ApiKeyModel.encryption.test.ts for the same
  // one-shot beforeAll pattern with no reset).
  configureSecretsAtRest(generateEncryptionKey());
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

describe('UserApiKeyModel callback signing secret (select: false)', () => {
  it('is absent from a plain findById / findByUserIdAndId read and from toJSON', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_cbsecret01' });
    await userApiKeyRepository.setCallbackSigningSecret(created.id, 'signing-secret-1', new Date());

    // A hydrated Mongoose document exposes a getter for every schema path regardless of
    // selection, so `in`/property access on the document itself always "succeeds" with
    // `undefined`. `toObject()`/`toJSON()` are the faithful check: they only serialize the
    // paths actually selected, so an unselected select:false path is a genuinely absent key.
    const byId = await UserApiKey.findById(created.id);
    expect(byId).not.toBeNull();
    expect(byId?.callbackSigningSecret).toBeUndefined();
    expect('callbackSigningSecret' in byId!.toObject()).toBe(false);

    const json = byId!.toJSON() as Record<string, unknown>;
    expect('callbackSigningSecret' in json).toBe(false);

    const byUserAndId = await userApiKeyRepository.findByUserIdAndId('user-1', created.id);
    expect(byUserAndId).not.toBeNull();
    expect('callbackSigningSecret' in byUserAndId!.toObject()).toBe(false);
  });

  it('round-trips the plaintext through setCallbackSigningSecret / findCallbackSigningSecret', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_cbsecret02' });
    const createdAt = new Date('2026-01-01T00:00:00Z');

    await userApiKeyRepository.setCallbackSigningSecret(created.id, 'my-plaintext-secret', createdAt);

    const found = await userApiKeyRepository.findCallbackSigningSecret(created.id);
    expect(found).not.toBeNull();
    expect(found?.secret).toBe('my-plaintext-secret');
    expect(found?.userId).toBe('user-1');
    expect(found?.status).toBe(ApiKeyStatus.ACTIVE);
  });

  it('stores the secret encrypted at rest, distinct from the plaintext, and still decrypts back', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_cbsecret03' });

    await userApiKeyRepository.setCallbackSigningSecret(created.id, 'another-plaintext-secret', new Date());

    const raw = await UserApiKey.findOne({ _id: created.id })
      .select('+callbackSigningSecret')
      .lean<{ callbackSigningSecret?: string }>();

    expect(raw?.callbackSigningSecret).toBeDefined();
    expect(isEncrypted(raw!.callbackSigningSecret as string)).toBe(true);
    expect(raw!.callbackSigningSecret).not.toBe('another-plaintext-secret');

    const found = await userApiKeyRepository.findCallbackSigningSecret(created.id);
    expect(found?.secret).toBe('another-plaintext-secret');
  });

  it('replaces a previously stored secret rather than accumulating', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_cbsecret05' });

    await userApiKeyRepository.setCallbackSigningSecret(created.id, 'first-secret', new Date('2026-01-01T00:00:00Z'));
    await userApiKeyRepository.setCallbackSigningSecret(created.id, 'second-secret', new Date('2026-02-01T00:00:00Z'));

    const found = await userApiKeyRepository.findCallbackSigningSecret(created.id);
    expect(found?.secret).toBe('second-secret');
  });

  it('returns null when the key has never had a signing secret set', async () => {
    const created = await UserApiKey.create({ ...base, keyPrefix: 'b4m_live_cbsecret04' });

    await expect(userApiKeyRepository.findCallbackSigningSecret(created.id)).resolves.toBeNull();
  });

  it('returns null for an id that does not resolve to any key', async () => {
    const missingId = new mongoose.Types.ObjectId().toString();

    await expect(userApiKeyRepository.findCallbackSigningSecret(missingId)).resolves.toBeNull();
  });
});
