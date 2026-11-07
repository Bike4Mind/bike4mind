import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  configureSecretsAtRest,
  decryptAtRest,
  encryptAtRest,
  generateEncryptionKey,
  isEncrypted,
} from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import { User } from '@bike4mind/database';
import migration from './20260921240020_encrypt-oauth-provider-tokens';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;
const KEY = generateEncryptionKey();

const users = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('users');
};

type StoredProvider = { strategy: string; accessToken?: string; refreshToken?: string; encrypted?: boolean };
const providersOf = async (email: string) =>
  ((await users().findOne({ email }))?.authProviders ?? []) as StoredProvider[];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  configureSecretsAtRest(KEY);
  await users().deleteMany({});
});
afterEach(() => {
  configureSecretsAtRest(undefined);
});

describe('encrypt OAuth provider tokens', () => {
  it('seals plaintext provider tokens and oauthCredentials, and the seal round-trips', async () => {
    await users().insertOne({
      email: 'legacy@example.com',
      authProviders: [
        { strategy: 'google', id: 'g-1', accessToken: 'ya29.plain', refreshToken: '1//refresh' },
        { strategy: 'github', id: 'gh-1', accessToken: 'gho_plain', refreshToken: '' },
      ],
      oauthCredentials: { id: 'gh-1', strategy: 'github', accessToken: 'gho_plain', refreshToken: '' },
    });

    await migration.up();

    const [google, github] = await providersOf('legacy@example.com');
    expect(google.encrypted).toBe(true);
    expect(isEncrypted(google.accessToken ?? '')).toBe(true);
    expect(decryptAtRest(google.accessToken ?? '')).toBe('ya29.plain');
    expect(decryptAtRest(google.refreshToken ?? '')).toBe('1//refresh');
    expect(github.encrypted).toBe(true);
    expect(decryptAtRest(github.accessToken ?? '')).toBe('gho_plain');
    expect(github.refreshToken).toBe('');

    const credentials = (await users().findOne({ email: 'legacy@example.com' }))?.oauthCredentials as StoredProvider;
    expect(credentials.encrypted).toBe(true);
    expect(decryptAtRest(credentials.accessToken ?? '')).toBe('gho_plain');
  });

  it('leaves already-sealed entries and token-less providers untouched', async () => {
    const sealed = encryptAtRest('apple-refresh');
    await users().insertOne({
      email: 'sealed@example.com',
      authProviders: [
        { strategy: 'apple', id: 'a-1', accessToken: sealed, encrypted: true },
        { strategy: 'saml', id: 'name-id' },
      ],
    });

    await migration.up();

    const [apple, saml] = await providersOf('sealed@example.com');
    expect(apple.accessToken).toBe(sealed);
    expect(saml).toEqual({ strategy: 'saml', id: 'name-id' });
  });

  it('is idempotent: a second run does not re-encrypt', async () => {
    await users().insertOne({
      email: 'twice@example.com',
      authProviders: [{ strategy: 'google', id: 'g-2', accessToken: 'ya29.once' }],
    });

    await migration.up();
    const first = (await providersOf('twice@example.com'))[0].accessToken;
    await migration.up();
    const second = (await providersOf('twice@example.com'))[0].accessToken;

    expect(second).toBe(first);
  });

  it('does not overwrite a token rewritten by a sign-in between read and write', async () => {
    await users().insertOne({
      email: 'race@example.com',
      authProviders: [{ strategy: 'google', id: 'g-3', accessToken: 'ya29.stale' }],
    });
    const fresh = encryptAtRest('ya29.fresh');
    const original = User.collection.updateOne.bind(User.collection);
    const spy = vi.spyOn(User.collection, 'updateOne');
    // Simulate a sign-in landing after the migration read the row but before it writes.
    spy.mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await users().updateOne(
        { email: 'race@example.com' },
        { $set: { 'authProviders.0.accessToken': fresh, 'authProviders.0.encrypted': true } }
      );
      return original(...args);
    });

    await migration.up();
    spy.mockRestore();

    expect((await providersOf('race@example.com'))[0].accessToken).toBe(fresh);
  });

  it('is a no-op without a key, keeping the keyless plaintext posture', async () => {
    configureSecretsAtRest(undefined);
    await users().insertOne({
      email: 'keyless@example.com',
      authProviders: [{ strategy: 'google', id: 'g-4', accessToken: 'ya29.keyless' }],
    });

    await expect(migration.up()).resolves.toBeUndefined();

    expect((await providersOf('keyless@example.com'))[0].accessToken).toBe('ya29.keyless');
  });
});
