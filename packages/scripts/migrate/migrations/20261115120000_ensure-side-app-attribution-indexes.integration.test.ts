import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { AgentExecutionModel, ApiKeyUsageLog, CreditTransaction, Quest } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261115120000_ensure-side-app-attribution-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await Promise.all([CreditTransaction, ApiKeyUsageLog, Quest, AgentExecutionModel].map(m => m.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('ensure-side-app-attribution-indexes migration (real DB)', () => {
  it('succeeds when an existing index differs from the schema, and builds the oauthClientId indexes', async () => {
    const collection = AgentExecutionModel.collection;
    await collection.dropIndexes();
    // Same name as the schema's TTL index but different options: createIndexes() would throw here.
    await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 123 });

    await migration.up();
    await migration.up();

    const indexes = await collection.indexes();
    expect(indexes.find(i => i.name === 'createdAt_1')?.expireAfterSeconds).toBe(123);
    for (const model of [CreditTransaction, ApiKeyUsageLog, Quest, AgentExecutionModel]) {
      const oauth = (await model.collection.indexes()).find(i => 'oauthClientId' in i.key);
      expect(oauth?.partialFilterExpression).toEqual({ oauthClientId: { $exists: true } });
    }
  });
});
