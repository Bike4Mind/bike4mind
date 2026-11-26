import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { OAuthClientSignInModel } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261126055954_ensure-oauth-client-sign-in-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await OAuthClientSignInModel.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('OAuthClientSignIn index migration', () => {
  it('builds the unique pair and per-user indexes with automatic indexes disabled, idempotently', async () => {
    expect(await OAuthClientSignInModel.collection.indexes()).toHaveLength(1);
    await migration.up();
    await migration.up();
    const indexes = await OAuthClientSignInModel.collection.indexes();
    expect(indexes.find(index => index.key.clientId === 1 && index.key.userId === 1)).toMatchObject({ unique: true });
    expect(indexes.some(index => index.key.userId === 1 && index.key.lastSignInAt === -1)).toBe(true);
    await migration.down();
    expect(await OAuthClientSignInModel.collection.indexes()).toEqual(indexes);
  });
});
