import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { User } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20260921235939_ensure-signup-fingerprint-window-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;
const indexName = 'user_signup_fingerprint_window';

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await User.createCollection();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

it('creates the window index idempotently and can roll it back and recreate it', async () => {
  expect((await User.collection.indexes()).some(index => index.name === indexName)).toBe(false);

  await migration.up();
  await migration.up();

  const indexes = await User.collection.indexes();
  const index = indexes.find(candidate => candidate.name === indexName);
  expect(index?.key).toEqual({ createdAt: 1, 'signupMeta.ja4': 1 });
  expect(Object.keys(index?.key ?? {})).toEqual(['createdAt', 'signupMeta.ja4']);
  expect(indexes.filter(candidate => candidate.name === indexName)).toHaveLength(1);

  await migration.down();
  expect((await User.collection.indexes()).some(candidate => candidate.name === indexName)).toBe(false);

  await migration.up();
  expect((await User.collection.indexes()).some(candidate => candidate.name === indexName)).toBe(true);
});
