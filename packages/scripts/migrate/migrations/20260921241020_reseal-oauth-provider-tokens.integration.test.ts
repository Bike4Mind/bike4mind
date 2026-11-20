import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { configureSecretsAtRest, decryptAtRest, encryptAtRest, generateEncryptionKey } from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921241020_reseal-oauth-provider-tokens';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;
const KEY = generateEncryptionKey();

const users = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('users');
};

type StoredTokens = { accessToken?: string; refreshToken?: string | null; encrypted?: boolean };

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

describe('re-seal OAuth provider tokens', () => {
  // A user sealed by the first run who then signed in with another provider during the cutover:
  // the pre-fix code wrote no refreshToken on the entry and null on oauthCredentials.
  it('seals a cutover sign-in and leaves the entry the first run sealed untouched', async () => {
    const sealedGithub = { strategy: 'github', id: 'gh-1', accessToken: encryptAtRest('gho_sealed'), encrypted: true };
    await users().insertOne({
      email: 'cutover@example.com',
      authProviders: [sealedGithub, { strategy: 'google', id: 'g-1', accessToken: 'ya29.plain' }],
      oauthCredentials: { id: 'g-1', strategy: 'google', accessToken: 'ya29.plain', refreshToken: null },
    });

    await migration.up();

    const row = await users().findOne({ email: 'cutover@example.com' });
    const [github, google] = (row?.authProviders ?? []) as StoredTokens[];
    const credentials = row?.oauthCredentials as StoredTokens;
    expect(github).toEqual(sealedGithub);
    expect(google.encrypted).toBe(true);
    expect(decryptAtRest(google.accessToken ?? '')).toBe('ya29.plain');
    expect(google.refreshToken).toBeUndefined();
    expect(credentials.encrypted).toBe(true);
    expect(decryptAtRest(credentials.accessToken ?? '')).toBe('ya29.plain');
    expect(credentials.refreshToken).toBeNull();
  });

  it('leaves already-sealed tokens unchanged when run again', async () => {
    await users().insertOne({
      email: 'twice@example.com',
      authProviders: [{ strategy: 'github', id: 'gh-1', accessToken: 'gho_plain' }],
    });
    await migration.up();
    const sealed = (await users().findOne({ email: 'twice@example.com' }))?.authProviders;

    await migration.up();

    expect((await users().findOne({ email: 'twice@example.com' }))?.authProviders).toEqual(sealed);
  });
});
