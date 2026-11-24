import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { OverwatchRawEvent, OverwatchUserDay } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261124180550_ensure-overwatch-user-id-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const MODELS = [OverwatchRawEvent, OverwatchUserDay];

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  for (const model of MODELS) await model.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const userIdIndex = async (model: (typeof MODELS)[number]) =>
  (await model.collection.indexes()).filter(i => i.name === 'userId_1');

describe('ensure-overwatch-user-id-indexes migration (real DB)', () => {
  it('builds the userId index on both collections, runs again without error, and matches the schema', async () => {
    for (const model of MODELS) await model.collection.dropIndex('userId_1');
    for (const model of MODELS) expect(await userIdIndex(model)).toEqual([]);

    await migration.up();
    await migration.up();
    // What autoIndex runs: a name or option drift from the schema would throw IndexOptionsConflict.
    for (const model of MODELS) await model.createIndexes();

    for (const model of MODELS) {
      expect((await userIdIndex(model)).map(i => i.key)).toEqual([{ userId: 1 }]);
    }
  });
});
